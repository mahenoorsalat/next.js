use std::{
    any::Any,
    collections::BTreeSet,
    env, fmt,
    mem::take,
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock,
        mpsc::{Receiver, RecvTimeoutError, channel},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use bincode::{Decode, Encode};
use bitflags::bitflags;
use notify::{
    Config, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher,
    event::{MetadataKind, ModifyKind, RenameMode},
};
use rustc_hash::{FxHashMap, FxHashSet};
use serde::Serialize;
use tokio::sync::{RwLock, RwLockWriteGuard};
use tracing::instrument;
use turbo_rcstr::RcStr;
use turbo_tasks::{
    FxIndexSet, InvalidationReason, InvalidationReasonKind, Invalidator, TurboTasksApi,
    message_queue::{CompilationEvent, Severity},
    parallel, spawn_thread,
    util::StaticOrArc,
};

use crate::{
    DiskFileSystemInner, format_absolute_fs_path,
    invalidation::{WatchChange, WatchStart},
    invalidator_map::InvalidatorMap,
    path_map::OrderedPathMapExt,
};

static WATCH_RECURSIVE_MODE: LazyLock<RecursiveMode> = LazyLock::new(|| {
    match env::var("TURBO_TASKS_FORCE_WATCH_MODE").as_deref() {
        Ok("recursive") => {
            return RecursiveMode::Recursive;
        }
        Ok("nonrecursive") => {
            return RecursiveMode::NonRecursive;
        }
        Ok(_) => {
            eprintln!(
                "unsupported `TURBO_TASKS_FORCE_WATCH_MODE`, must be `recursive` or `nonrecursive`"
            );
        }
        _ => {}
    }
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        // these platforms have efficient recursive watchers, it's best to track the entire
        // directory and filter events to the files we care about
        RecursiveMode::Recursive
    } else {
        // inotify on linux is non-recursive, so notify-rs's implementation is inefficient, it's
        // better for us to just track it ourselves and only watch the files we know we care about
        //
        // See: https://github.com/vercel/turborepo/pull/4100
        RecursiveMode::NonRecursive
    }
});

/// A predicate over the absolute paths reported by the filesystem watcher. See
/// [`DiskWatcherConfig::extended_batch_delay_matcher`].
pub type PathMatcher = Arc<dyn Fn(&Path) -> bool + Send + Sync>;

/// Tunables for the filesystem watcher, passed to [`crate::DiskFileSystem::start_watching`].
/// Defaults are appropriate for a generic watcher; consumers (e.g. a bundler front-end) can extend
/// the batch delay for noisy directories like package-manager install targets.
#[derive(Clone)]
pub struct DiskWatcherConfig {
    /// When set, poll the filesystem at this interval instead of using the platform's native
    /// filesystem notification API.
    pub poll_interval: Option<Duration>,
    /// How long to keep a batch of filesystem events open, waiting for more events, before
    /// flushing invalidations. Batching coalesces bursts (e.g. a `git checkout`) into a single
    /// invalidation pass and avoids reading half-written files.
    pub batch_delay: Duration,
    /// Predicate over the absolute paths reported by the watcher. Whenever an event matches, the
    /// current batch is held open until [`Self::extended_batch_delay_duration`] has passed without
    /// another match, instead of the usual [`Self::batch_delay`].
    ///
    /// This is a sliding window, so sustained changes to matching paths (e.g. a package manager
    /// installing dependencies) keep the batch open for as long as they continue. That's the point
    /// — such a directory is unusable until the writer is done — but it means invalidation of
    /// *every* path in the batch is deferred, which is why [`FilesystemSettlingEvent`] exists.
    pub extended_batch_delay_matcher: Option<PathMatcher>,
    /// The quiet period required to close a batch once [`Self::extended_batch_delay_matcher`] has
    /// matched. Unused when there is no matcher.
    pub extended_batch_delay_duration: Duration,
    /// If a single batch stays open at least this long, emit a [`FilesystemSettlingEvent`]
    /// compilation event so the user knows why work has stalled. Repeated events within the same
    /// batch back off exponentially, up to [`Self::compilation_event_max_delay`].
    pub compilation_event_delay: Duration,
    /// Upper bound for the exponentially increasing interval between repeated
    /// [`FilesystemSettlingEvent`]s within a single batch.
    pub compilation_event_max_delay: Duration,
}

impl Default for DiskWatcherConfig {
    fn default() -> Self {
        Self {
            poll_interval: None,
            batch_delay: Duration::from_millis(10),
            extended_batch_delay_matcher: None,
            extended_batch_delay_duration: Duration::from_millis(200),
            compilation_event_delay: Duration::from_secs(3),
            compilation_event_max_delay: Duration::from_secs(60),
        }
    }
}

#[derive(Encode, Decode)]
pub(crate) struct DiskWatcher {
    /// Not serialized: Always constructed with [`State::new_stopped`]
    #[bincode(skip)]
    state: State,
}

enum State {
    // Note: Information about if we're a recursive or non-recursive watcher must live outside the
    // `RwLock` to allow us to quickly bail out on calls to `ensure_watched`.
    Recursive(RwLock<RecursiveState>),
    NonRecursive(RwLock<NonRecursiveState>),
}

impl Default for State {
    fn default() -> Self {
        State::new_stopped()
    }
}

enum StateWriteGuard<'a> {
    Recursive(RwLockWriteGuard<'a, RecursiveState>),
    NonRecursive(RwLockWriteGuard<'a, NonRecursiveState>),
}

impl State {
    fn new_stopped() -> Self {
        match *WATCH_RECURSIVE_MODE {
            RecursiveMode::Recursive => Self::Recursive(RwLock::new(RecursiveState::Stopped)),
            RecursiveMode::NonRecursive => {
                Self::NonRecursive(RwLock::new(NonRecursiveState::Stopped))
            }
        }
    }

    async fn write(&self) -> StateWriteGuard<'_> {
        match self {
            Self::Recursive(state) => StateWriteGuard::Recursive(state.write().await),
            Self::NonRecursive(state) => StateWriteGuard::NonRecursive(state.write().await),
        }
    }

    fn recursive_mode(&self) -> RecursiveMode {
        match self {
            Self::Recursive(_) => RecursiveMode::Recursive,
            Self::NonRecursive(_) => RecursiveMode::NonRecursive,
        }
    }
}

/// Used by when [`WATCH_RECURSIVE_MODE`] is [`RecursiveMode::Recursive`] (default on macOS and
/// Windows).
enum RecursiveState {
    /// Used when [`DiskWatcher::start_watching`] hasn't been called yet or after
    /// [`DiskWatcher::stop_watching`] is called.
    Stopped,
    Watching {
        /// Hold onto the watcher: When this is dropped, it will cause the channel to disconnect
        _notify_watcher: NotifyWatcher,
    },
}

/// Used by when [`WATCH_RECURSIVE_MODE`] is [`RecursiveMode::NonRecursive`] (default on Linux).
enum NonRecursiveState {
    /// Used when [`DiskWatcher::start_watching`] hasn't been called yet or after
    /// [`DiskWatcher::stop_watching`] is called.
    Stopped,
    Watching(NonRecursiveWatchingState),
}

// split out from the `NonRecursiveState` enum because we want to pass this value around
struct NonRecursiveWatchingState {
    notify_watcher: NotifyWatcher,
    /// Keeps track of which directories are currently or were previously watched by
    /// [`Self::notify_watcher`].
    ///
    /// Invariants:
    /// - Never contains `root_path`. A watcher for `root_path` is implicitly set up during
    ///   [`DiskWatcher::start_watching`].
    /// - Contains all parent directories up to `root_path` for every entry.
    watched: BTreeSet<PathBuf>,
}

/// A thin wrapper around [`RecommendedWatcher`] and [`PollWatcher`].
enum NotifyWatcher {
    Recommended(RecommendedWatcher),
    Polling(PollWatcher),
}

impl NotifyWatcher {
    fn watch(&mut self, path: &Path, recursive_mode: RecursiveMode) -> notify::Result<()> {
        match self {
            Self::Recommended(watcher) => watcher.watch(path, recursive_mode),
            Self::Polling(watcher) => watcher.watch(path, recursive_mode),
        }
    }
}

mod non_recursive_helpers {
    use super::*;
    use crate::path_map::OrderedPathSetExt;

    /// Called after a rescan in case a previously watched-but-deleted directory was recreated.
    #[instrument(skip_all, level = "trace")]
    pub async fn restore_all_watched_ignore_errors(
        state: &RwLock<NonRecursiveState>,
        root_path: &Path,
    ) {
        let mut guard = state.write().await;
        let NonRecursiveState::Watching(watching_state) = &mut *guard else {
            return;
        };
        for dir_path in watching_state.watched.iter() {
            // TODO: Report diagnostics if this error happens
            //
            // Don't watch the parents, because those are already included in `self.watched` (so
            // it'd be redundant), but also because this could deadlock, since we'd try to modify
            // `self.watched` while iterating over it (write lock overlapping with a read lock).
            let _ = start_watching_dir(&mut watching_state.notify_watcher, dir_path, root_path);
        }
    }

    /// Called when a new directory is found in a parent directory we're watching. Restores the
    /// watcher if we were previously watching it.
    #[instrument(skip_all, level = "trace")]
    pub async fn restore_if_watched(
        state: &RwLock<NonRecursiveState>,
        dir_path: &Path,
        root_path: &Path,
    ) -> Result<()> {
        // fast path: The root directory is always implicitly watched during
        // `DiskWatcher::start_watching`, we assume it is never deleted and never needs to be
        // restored.
        if dir_path == root_path {
            return Ok(());
        }

        // fast path: the directory isn't in `watched`, only take a read lock and bail out early
        {
            let guard = state.read().await;
            let NonRecursiveState::Watching(watching_state) = &*guard else {
                return Ok(());
            };
            if !watching_state.watched.contains(dir_path) {
                return Ok(());
            }
        }

        // slow path: re-watch the path
        let mut guard = state.write().await;
        let NonRecursiveState::Watching(watching_state) = &mut *guard else {
            return Ok(());
        };

        // watch the new directory
        start_watching_dir(&mut watching_state.notify_watcher, dir_path, root_path)?;

        // Also try to restore any watchers for children of this directory
        for child_path in watching_state.watched.iter_path_children(dir_path) {
            // Don't watch the parents -- see the comment on `restore_all_watched`
            start_watching_dir(&mut watching_state.notify_watcher, child_path, root_path)?;
        }
        Ok(())
    }

    /// Called when a file in `dir_path` or `dir_path` itself is read or written. Adds a new watcher
    /// if we're not already watching the directory.
    ///
    /// This should be called *before* reading a file to avoid a race condition.
    #[instrument(skip_all, level = "trace")]
    pub async fn ensure_watched(
        state: &RwLock<NonRecursiveState>,
        dir_path: &Path,
        root_path: &Path,
    ) -> Result<()> {
        // fast path: The root directory is always implicitly watched during
        // `DiskWatcher::start_watching`.
        if dir_path == root_path {
            return Ok(());
        }

        // fast path: the directory is already in `watched`, only take a read lock and bail out
        // early
        {
            let guard = state.read().await;
            let NonRecursiveState::Watching(watching_state) = &*guard else {
                return Ok(());
            };
            if watching_state.watched.contains(dir_path) {
                return Ok(());
            }
        }

        // slow path: watch the path
        let mut guard = state.write().await;
        let NonRecursiveState::Watching(watching_state) = &mut *guard else {
            return Ok(());
        };
        if watching_state.watched.insert(dir_path.to_path_buf()) {
            start_watching_dir_and_parents(watching_state, dir_path, root_path)?;
        }
        Ok(())
    }

    /// Private helper, assumes that `dir_path` has already been added to
    /// [`NonRecursiveWatchingState::watched`].
    ///
    /// This does not watch any of the parent directories. For that, use
    /// [`start_watching_dir_and_parents`]. Use this method when iterating over previously-watched
    /// values in `self.watching`.
    fn start_watching_dir(
        notify_watcher: &mut NotifyWatcher,
        dir_path: &Path,
        root_path: &Path,
    ) -> Result<()> {
        debug_assert_ne!(dir_path, root_path);

        match notify_watcher.watch(dir_path, RecursiveMode::NonRecursive) {
            Ok(())
            | Err(notify::Error {
                // The path was probably deleted before we could process the event, but the parent
                // should still be watched. The codepaths that care about this either call
                // `start_watching_dir_and_parents` or handle the parents themselves.
                kind: notify::ErrorKind::PathNotFound,
                ..
            }) => Ok(()),
            Err(err) => {
                // ast-grep-ignore: no-context-format
                return Err(err).context(format!("Unable to watch {}", dir_path.display(),));
            }
        }
    }

    /// Private helper, assumes that `dir_path` has already been added to
    /// [`NonRecursiveWatchingState::watched`].
    ///
    /// Watches the given `dir_path` and every parent up to `root_path`. Parents must be recursively
    /// watched in case any of them change:
    /// https://docs.rs/notify/latest/notify/#parent-folder-deletion
    fn start_watching_dir_and_parents(
        state: &mut NonRecursiveWatchingState,
        dir_path: &Path,
        root_path: &Path,
    ) -> Result<()> {
        let mut found_watched_ancestor = false;

        // NOTE: `Path::ancestors` yields ancestors from longest to shortest path.
        let dir_and_ancestor_paths: Vec<_> = [dir_path]
            .into_iter()
            .chain(
                dir_path
                    .ancestors()
                    // skip: `ancestors` includes `dir_path` itself, as well as the ancestors, but
                    // we only want to apply the `take_while` check to parents
                    .skip(1)
                    .take_while(|p| {
                        found_watched_ancestor = *p == root_path || state.watched.contains(*p);
                        !found_watched_ancestor
                    }),
            )
            .collect();

        if !found_watched_ancestor {
            // this should never happen, as we should eventually hit the `root_path`
            anyhow::bail!(
                "failed to find the fs root of {root_path:?} while watching {dir_path:?}"
            );
        }

        // Reverse the iterator: We want to start closest to the root and work towards `dir_path`
        // (opposite of `Path::ancestors`), to avoid a potential race condition if directories are
        // removed and re-added before we've watched their parent.
        for path in dir_and_ancestor_paths.into_iter().rev() {
            // this will silently ignore if the path is not found, expecting that we've watched the
            // parent directory
            start_watching_dir(&mut state.notify_watcher, path, root_path)?;
            state.watched.insert(path.to_owned());
        }

        Ok(())
    }
}

impl DiskWatcher {
    pub fn new() -> Self {
        Self {
            state: State::new_stopped(),
        }
    }

    /// Create a watcher and start watching by creating `debounced` watcher
    /// via `full debouncer`
    ///
    /// `notify` provides 2 different debouncer implementations, `-full`
    /// provides below differences for the easy of use:
    ///
    /// - Only emits a single Rename event if the rename From and To events can be matched
    /// - Merges multiple Rename events
    /// - Takes Rename events into account and updates paths for events that occurred before the
    ///   rename event, but which haven't been emitted, yet
    /// - Optionally keeps track of the file system IDs all files and stitches rename events
    ///   together (FSevents, Windows)
    /// - Emits only one Remove event when deleting a directory (inotify)
    /// - Doesn't emit duplicate create events
    /// - Doesn't emit Modify events after a Create event
    pub async fn start_watching(
        &self,
        fs_inner: Arc<DiskFileSystemInner>,
        report_invalidation_reason: bool,
        watcher_config: DiskWatcherConfig,
    ) -> Result<()> {
        let state_guard = self.state.write().await;

        // bail out if we're already watching
        if let StateWriteGuard::Recursive(guard) = &state_guard
            && matches!(**guard, RecursiveState::Watching { .. })
        {
            return Ok(());
        } else if let StateWriteGuard::NonRecursive(guard) = &state_guard
            && matches!(**guard, NonRecursiveState::Watching(..))
        {
            return Ok(());
        }

        // Create a channel to receive the events.
        let (tx, rx) = channel();
        // Create a watcher object, delivering debounced events.
        // The notification back-end is selected based on the platform.
        let config = Config::default();
        // we should track and invalidate each part of a symlink chain ourselves in
        // turbo-tasks-fs
        let config = config.with_follow_symlinks(false);

        let mut notify_watcher = if let Some(poll_interval) = watcher_config.poll_interval {
            let config = config.with_poll_interval(poll_interval);
            NotifyWatcher::Polling(PollWatcher::new(tx, config)?)
        } else {
            NotifyWatcher::Recommended(RecommendedWatcher::new(tx, config)?)
        };

        // TOCTOU: we must watch `root_path` before calling any invalidators and setting up the
        // watchers in their associated functions
        let root_path = fs_inner.root_path();
        let recursive_mode = match state_guard {
            StateWriteGuard::Recursive(_) => RecursiveMode::Recursive,
            StateWriteGuard::NonRecursive(_) => RecursiveMode::NonRecursive,
        };
        notify_watcher.watch(root_path, recursive_mode)?;

        // We need to invalidate all reads or writes that happened before watching. As a
        // side-effect, this will call `ensure_watched` again, setting up any watchers needed.
        //
        // Best is to start_watching before starting to read
        if let Some(turbo_tasks) = fs_inner.turbo_tasks.upgrade() {
            let _span = tracing::info_span!("invalidate filesystem").entered();
            let _guard = fs_inner.tokio_handle.enter();
            let invalidator_map = take(&mut *fs_inner.invalidator_map.lock().unwrap());
            let dir_invalidator_map = take(&mut *fs_inner.dir_invalidator_map.lock().unwrap());
            let iter = invalidator_map.into_iter().chain(dir_invalidator_map);
            if report_invalidation_reason {
                let invalidators = iter
                    .flat_map(|(path, invalidators)| {
                        let reason = WatchStart {
                            name: fs_inner.name.clone(),
                            // this path is just used for display purposes
                            path: RcStr::from(path.to_string_lossy()),
                        };
                        invalidators.into_iter().map(move |i| (reason.clone(), i))
                    })
                    .collect::<Vec<_>>();
                parallel::for_each_owned(invalidators, |(reason, invalidator)| {
                    invalidator.invalidate_with_reason(&*turbo_tasks, reason);
                });
            } else {
                let invalidators = iter
                    .flat_map(|(_, invalidators)| invalidators.into_iter())
                    .collect::<Vec<_>>();
                parallel::for_each_owned(invalidators, |invalidator| {
                    invalidator.invalidate(&*turbo_tasks);
                });
            }
        }

        spawn_thread(move || {
            fs_inner.clone().watcher.watch_thread(
                rx,
                fs_inner,
                report_invalidation_reason,
                watcher_config,
            )
        });

        // Updating `self.state` is done last. If we panic while setting up the watcher, it'll
        // stay in the `Stopped` state.
        match state_guard {
            StateWriteGuard::Recursive(mut recursive) => {
                *recursive = RecursiveState::Watching {
                    _notify_watcher: notify_watcher,
                }
            }
            StateWriteGuard::NonRecursive(mut non_recursive) => {
                *non_recursive = NonRecursiveState::Watching(NonRecursiveWatchingState {
                    notify_watcher,
                    watched: BTreeSet::new(),
                })
            }
        };

        Ok(())
    }

    pub async fn stop_watching(&self) {
        match &self.state {
            State::Recursive(state) => *state.write().await = RecursiveState::Stopped,
            State::NonRecursive(state) => *state.write().await = NonRecursiveState::Stopped,
        }
        // thread will detect the stop because the channel is disconnected when `NotifyWatcher` is
        // dropped
    }

    /// Internal thread that processes the events from the watcher
    /// and invalidates the cache.
    ///
    /// Should only be called once from `start_watching`.
    fn watch_thread(
        &self,
        rx: Receiver<notify::Result<notify::Event>>,
        fs_inner: Arc<DiskFileSystemInner>,
        report_invalidation_reason: bool,
        config: DiskWatcherConfig,
    ) {
        let mut batch = BatchedInvalidations::new(self.state.recursive_mode());

        // Waits for the next event of the current batch, reporting `Timeout` only once the batch is
        // complete (i.e. once `deadline` has passed). Batching coalesces bursts (e.g. a `git
        // checkout`) into a single invalidation pass and avoids reading half-written files. A
        // `None` deadline means the batch is still empty, so there's nothing to flush:
        // block until it opens.
        //
        // Because the extended delay can hold a batch open for as long as a writer keeps working,
        // we also emit `FilesystemSettlingEvent`s on `settling`'s schedule while waiting, so the
        // user learns why nothing has recompiled.
        let drain_next = |deadline: Option<Instant>,
                          settling: &mut SettlingSchedule|
         -> Result<notify::Result<notify::Event>, RecvTimeoutError> {
            let Some(deadline) = deadline else {
                return rx.recv().map_err(|_| RecvTimeoutError::Disconnected);
            };
            loop {
                let wake = deadline.min(settling.next_event_at);
                match rx.recv_timeout(wake.saturating_duration_since(Instant::now())) {
                    Err(RecvTimeoutError::Timeout) if Instant::now() < deadline => {
                        settling.emit(&fs_inner)
                    }
                    result => return result,
                }
            }
        };

        // Pushes `deadline` out to at least `now + delay`, never moving it backwards. The first
        // event to contribute to a batch opens it, which is also when its settling schedule starts:
        // `FilesystemSettlingEvent` reports how long the batch has been held open, not how long the
        // watcher sat idle waiting for one to open.
        let extend_batch = |deadline: &mut Option<Instant>,
                            settling: &mut SettlingSchedule<'_>,
                            delay: Duration| {
            let now = Instant::now();
            match *deadline {
                Some(current) => *deadline = Some(current.max(now + delay)),
                None => {
                    settling.restart(now);
                    *deadline = Some(now + delay);
                }
            }
        };

        'outer: loop {
            let mut deadline: Option<Instant> = None;
            // Placeholder start time; `extend_batch` resets this when the batch opens.
            let mut settling = SettlingSchedule::new(&config, Instant::now());

            loop {
                match drain_next(deadline, &mut settling) {
                    Ok(Ok(event)) => {
                        // TODO: We might benefit from some user-facing diagnostics if it rescans
                        // occur frequently (i.e. more than X times in Y minutes)
                        //
                        // You can test rescans on Linux by reducing the inotify queue to something
                        // really small:
                        //
                        // ```
                        // echo 3 | sudo tee /proc/sys/fs/inotify/max_queued_events
                        // ```
                        if event.need_rescan() {
                            let _lock = fs_inner.invalidation_lock.blocking_write();

                            // flush the whole mpsc queue, we're about to rescan, we don't need to
                            // process any other update events that have already happened
                            while rx.try_recv().is_ok() {}

                            if let State::NonRecursive(non_recursive) = &self.state {
                                // we can't narrow this down to a smaller set of paths: Rescan
                                // events (at least when tested on
                                // Linux) come with no `paths`, and we use
                                // only one global `notify::Watcher` instance.
                                //
                                // TODO: Report diagnostics if an error happens
                                fs_inner.tokio_handle.block_on(
                                    non_recursive_helpers::restore_all_watched_ignore_errors(
                                        non_recursive,
                                        fs_inner.root_path(),
                                    ),
                                );
                            }

                            if report_invalidation_reason {
                                fs_inner.invalidate_with_reason(|path| InvalidateRescan {
                                    // this path is just used for display purposes
                                    path: RcStr::from(path.to_string_lossy()),
                                });
                            } else {
                                fs_inner.invalidate();
                            }

                            // no need to process the rest of the batch as we just
                            // invalidated everything
                            batch.clear();
                            break;
                        }

                        // Any event that contributes to the batch keeps it open for another
                        // `batch_delay`. A path matching `extended_batch_delay_matcher` (e.g. a
                        // package-manager install target) keeps it open for
                        // `extended_batch_delay_duration` instead.
                        let mut delay = config.batch_delay;
                        if let Some(matcher) = &config.extended_batch_delay_matcher
                            && event.paths.iter().any(|path| matcher(path))
                        {
                            delay = delay.max(config.extended_batch_delay_duration);
                        }

                        if batch.add_event(event) {
                            extend_batch(&mut deadline, &mut settling, delay);
                        }
                    }
                    // Error raised by notify watcher itself
                    Ok(Err(notify::Error { kind, paths })) => {
                        println!("watch error ({paths:?}): {kind:?} ");

                        let flags = InvalidationFlags::PATH_AND_CHILDREN
                            | InvalidationFlags::PATH_AND_CHILDREN_DIR;
                        if paths.is_empty() {
                            batch.mark(fs_inner.root_path().into(), flags);
                        } else {
                            for path in paths {
                                batch.mark(path.into_boxed_path(), flags);
                            }
                        }
                        extend_batch(&mut deadline, &mut settling, config.batch_delay);
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        // `drain_next` only reports a timeout once `deadline` has passed, so the
                        // batch is complete: break out to invalidate the collected paths.
                        break;
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        // Sender has been disconnected, which means DiskFileSystem has been dropped
                        // exit thread
                        break 'outer;
                    }
                }
            }

            // We need to start watching first before invalidating the changed paths...
            // This is only needed on platforms we don't do recursive watching on.
            if let State::NonRecursive(non_recursive) = &self.state {
                for path in batch.new_paths() {
                    // TODO: Report diagnostics if this error happens
                    let _ =
                        fs_inner
                            .tokio_handle
                            .block_on(non_recursive_helpers::restore_if_watched(
                                non_recursive,
                                path,
                                fs_inner.root_path(),
                            ));
                }
            }

            let Some(turbo_tasks) = fs_inner.turbo_tasks.upgrade() else {
                // TurboTasks was dropped, stop watching
                break 'outer;
            };
            let _guard = fs_inner.tokio_handle.enter();

            let _lock = fs_inner.invalidation_lock.blocking_write();
            batch.execute(
                &fs_inner.invalidator_map,
                &fs_inner.dir_invalidator_map,
                |invalidation_reason_path, invalidator| {
                    invalidate(
                        &fs_inner,
                        &*turbo_tasks,
                        report_invalidation_reason,
                        invalidation_reason_path,
                        invalidator,
                    )
                },
            );
        }
    }

    pub async fn ensure_watched_file(&self, path: &Path, root_path: &Path) -> Result<()> {
        // Watch the parent directory instead of the specified file, since directories also track
        // their immediate children (even in non-recursive mode), and we need to watch all the
        // parents anyways.
        if let State::NonRecursive(non_recursive) = &self.state
            && let Some(dir_path) = path.parent()
        {
            non_recursive_helpers::ensure_watched(non_recursive, dir_path, root_path).await?;
        }
        Ok(())
    }

    pub async fn ensure_watched_dir(&self, dir_path: &Path, root_path: &Path) -> Result<()> {
        if let State::NonRecursive(non_recursive) = &self.state {
            non_recursive_helpers::ensure_watched(non_recursive, dir_path, root_path).await?;
        }
        Ok(())
    }
}

bitflags! {
    /// Describes how a single path in a [`BatchedInvalidations`] should be invalidated. A path may
    /// carry any combination of these (accumulated across the events in a batch).
    struct InvalidationFlags: u8 {
        /// Invalidate exactly this path in the file-content invalidator map.
        const PATH = 1 << 0;
        /// Invalidate exactly this path in the directory-listing invalidator map.
        const PATH_DIR = 1 << 1;
        /// Invalidate this path and all of its children in the file-content invalidator map.
        const PATH_AND_CHILDREN = 1 << 2;
        /// Invalidate this path and all of its children in the directory-listing invalidator map.
        const PATH_AND_CHILDREN_DIR = 1 << 3;
    }
}

/// A set of deferred invalidations. Because one or more files may be updated many times in quick
/// succession, we don't want to perform invalidations until we think the filesystem has settled.
///
/// This avoids reading partially-written files which might generate transient errors, and reduces
/// CPU and memory usage by producing less wasted work.
///
/// Paths are stored once in a flag-keyed map, with a set of [`InvalidationFlags`] describing what
/// needs to happen for each, rather than in several separate sets. This avoids cloning each
/// `PathBuf` into multiple collections.
struct BatchedInvalidations {
    paths: FxHashMap<Box<Path>, InvalidationFlags>,
    /// See [`Self::new_paths`]). Stored as [`None`] in non-recursive mode.
    new_paths: Option<FxHashSet<Box<Path>>>,
}

impl BatchedInvalidations {
    fn new(recursive_mode: RecursiveMode) -> Self {
        Self {
            paths: FxHashMap::default(),
            new_paths: match recursive_mode {
                RecursiveMode::NonRecursive => Some(FxHashSet::default()),
                RecursiveMode::Recursive => None,
            },
        }
    }

    fn clear(&mut self) {
        self.paths.clear();
        if let Some(new_paths) = &mut self.new_paths {
            new_paths.clear();
        }
    }

    /// Records `path` as newly-created so its watch can be (re-)established. No-op in recursive
    /// watching mode.
    fn mark_new_path(&mut self, path: &Path) {
        if let Some(new_paths) = &mut self.new_paths {
            new_paths.insert(Box::from(path));
        }
    }

    fn mark(&mut self, path: Box<Path>, flags: InvalidationFlags) {
        *self.paths.entry(path).or_insert(InvalidationFlags::empty()) |= flags;
    }

    fn mark_parent_dir(&mut self, path: &Path) {
        if let Some(parent) = path.parent() {
            self.mark(Box::from(parent), InvalidationFlags::PATH_DIR);
        }
    }

    /// Iterates over the newly-created paths in this batch. In non-recursive watching mode, these
    /// must have their watches (re-)established before [`Self::execute`] is called (see the note
    /// there). Always empty in recursive mode.
    fn new_paths(&self) -> impl Iterator<Item = &Path> {
        self.new_paths.iter().flatten().map(|path| &**path)
    }

    /// Updates the batch to contain updated paths from the given event. Does not perform any
    /// invalidations.
    ///
    /// Returns `true` if the event contained relevant events, or `false` if it was filtered out.
    #[must_use]
    fn add_event(&mut self, event: notify::Event) -> bool {
        let paths: Vec<PathBuf> = event.paths;
        if paths.is_empty() {
            return false;
        }
        match event.kind {
            // [NOTE] Observing `ModifyKind::Metadata(MetadataKind::Any)` is not a mistake, fix for
            // PACK-2437.
            // In here explicitly subscribes to the `ModifyKind::Data` which indicates file content
            // changes - in case of fsevents backend, this is `kFSEventStreamEventFlagItemModified`.
            // Also meanwhile we subscribe to `ModifyKind::Metadata` as well.
            // This is due to in some cases fsevents does not emit explicit
            // `kFSEventStreamEventFlagItemModified` kernel events, but only emits
            // `kFSEventStreamEventFlagItemInodeMetaMod`. While this could cause redundant
            // invalidation, it's the way to reliably detect file content changes.
            // ref other implementation, i.e libuv does same thing to trigger `UV_CHANGES`
            // https://github.com/libuv/libuv/commit/73cf3600d75a5884b890a1a94048b8f3f9c66876
            EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(MetadataKind::Any)) => {
                for path in paths {
                    self.mark(path.into_boxed_path(), InvalidationFlags::PATH);
                }
                true
            }
            EventKind::Create(_) => {
                for path in paths {
                    self.mark_parent_dir(&path);
                    self.mark_new_path(&path);
                    self.mark(
                        path.into_boxed_path(),
                        InvalidationFlags::PATH_AND_CHILDREN
                            | InvalidationFlags::PATH_AND_CHILDREN_DIR,
                    );
                }
                true
            }
            EventKind::Remove(_) => {
                for path in paths {
                    self.mark_parent_dir(&path);
                    self.mark(
                        path.into_boxed_path(),
                        InvalidationFlags::PATH_AND_CHILDREN
                            | InvalidationFlags::PATH_AND_CHILDREN_DIR,
                    );
                }
                true
            }
            // A single event emitted with both the `From` and `To` paths.
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
                let [source, destination] = <[PathBuf; 2]>::try_from(paths)
                    .expect("RenameMode::Both event must contain exactly two paths");
                self.mark_parent_dir(&source);
                self.mark(
                    source.into_boxed_path(),
                    InvalidationFlags::PATH_AND_CHILDREN,
                );
                self.mark_parent_dir(&destination);
                self.mark_new_path(&destination);
                self.mark(
                    destination.into_boxed_path(),
                    InvalidationFlags::PATH_AND_CHILDREN,
                );
                true
            }
            // We expect `RenameMode::Both` to cover most of the cases we need to invalidate,
            // but we also check other RenameModes to cover cases where notify couldn't match the
            // two rename events.
            EventKind::Any | EventKind::Modify(ModifyKind::Any | ModifyKind::Name(..)) => {
                for path in paths {
                    self.mark_parent_dir(&path);
                    self.mark(
                        path.into_boxed_path(),
                        InvalidationFlags::PATH_AND_CHILDREN
                            | InvalidationFlags::PATH_AND_CHILDREN_DIR,
                    );
                }
                true
            }
            EventKind::Modify(ModifyKind::Metadata(..) | ModifyKind::Other)
            | EventKind::Access(_)
            | EventKind::Other => {
                // ignored
                false
            }
        }
    }

    /// Performs all batched invalidations, calling `invalidate` once for each `(path, invalidator)`
    /// pair that needs to be invalidated, then clears the batch.
    ///
    /// In non-recursive watching mode, [`Self::new_paths`] must be processed (to (re-)establish
    /// watches) *before* calling this.
    ///
    /// For each path, a recursive invalidation subsumes an exact one, as
    /// [`extract_path_with_children`][OrderedPathMapExt::extract_path_with_children] removes the
    /// path itself in addition to its children.
    fn execute(
        &mut self,
        invalidator_map: &InvalidatorMap,
        dir_invalidator_map: &InvalidatorMap,
        invalidate: impl Fn(&Path, Invalidator),
    ) {
        for (map, exact_flag, recursive_flag) in [
            (
                invalidator_map,
                InvalidationFlags::PATH,
                InvalidationFlags::PATH_AND_CHILDREN,
            ),
            (
                dir_invalidator_map,
                InvalidationFlags::PATH_DIR,
                InvalidationFlags::PATH_AND_CHILDREN_DIR,
            ),
        ] {
            let mut map = map.lock().unwrap();
            for (path, flags) in &self.paths {
                if flags.contains(recursive_flag) {
                    for (_, invalidators) in map.extract_path_with_children(path) {
                        for invalidator in invalidators {
                            invalidate(path, invalidator);
                        }
                    }
                } else if flags.contains(exact_flag)
                    && let Some(invalidators) = map.remove(&**path)
                {
                    for invalidator in invalidators {
                        invalidate(path, invalidator);
                    }
                }
            }
        }
        self.clear();
    }
}

#[instrument(
    parent = None,
    level = "info",
    name = "file change",
    skip_all,
    fields(name = %invalidation_reason_path.display())
)]
fn invalidate(
    inner: &DiskFileSystemInner,
    turbo_tasks: &dyn TurboTasksApi,
    report_invalidation_reason: bool,
    invalidation_reason_path: &Path,
    invalidator: Invalidator,
) {
    if report_invalidation_reason
        && let Some(path) =
            format_absolute_fs_path(invalidation_reason_path, &inner.name, inner.root_path())
    {
        invalidator.invalidate_with_reason(turbo_tasks, WatchChange { path });
        return;
    }
    invalidator.invalidate(turbo_tasks);
}

/// Schedules the repeated [`FilesystemSettlingEvent`] for a single batch of watcher events. The
/// interval grows exponentially so that a writer holding a batch open for minutes doesn't flood the
/// compilation event queue.
struct SettlingSchedule<'a> {
    config: &'a DiskWatcherConfig,
    batch_started: Instant,
    /// When the next event should be emitted.
    next_event_at: Instant,
    /// The interval that led up to [`Self::next_event_at`].
    interval: Duration,
}

impl<'a> SettlingSchedule<'a> {
    fn new(config: &'a DiskWatcherConfig, batch_started: Instant) -> Self {
        Self {
            config,
            batch_started,
            next_event_at: batch_started + config.compilation_event_delay,
            interval: config.compilation_event_delay,
        }
    }

    /// Restarts the schedule, as if the batch had just opened at `batch_started`.
    fn restart(&mut self, batch_started: Instant) {
        *self = Self::new(self.config, batch_started);
    }

    fn emit(&mut self, fs_inner: &DiskFileSystemInner) {
        let _guard = fs_inner.tokio_handle.enter();
        if let Some(turbo_tasks) = fs_inner.turbo_tasks.upgrade() {
            turbo_tasks.send_compilation_event(Arc::new(FilesystemSettlingEvent {
                elapsed_secs: self.batch_started.elapsed().as_secs(),
            }));
        }
        self.interval = (self.interval * 2).min(self.config.compilation_event_max_delay);
        // Schedule from "now" instead of accumulating intervals, so that emitting late (e.g. under
        // heavy load) doesn't produce a catch-up burst of events.
        self.next_event_at = Instant::now() + self.interval;
    }
}

/// Emitted while the watcher is holding a batch of filesystem events open, waiting for frequent
/// updates (e.g. a running package manager) to settle before invalidating. Because the batch delay
/// can be extended for as long as those updates continue, this event lets consumers surface why
/// work appears stalled.
///
/// Repeated for as long as the batch stays open, at an exponentially increasing interval starting
/// at [`DiskWatcherConfig::compilation_event_delay`] and capped at
/// [`DiskWatcherConfig::compilation_event_max_delay`].
#[derive(Debug, Clone, Serialize)]
pub struct FilesystemSettlingEvent {
    /// How long the current batch has been held open, in whole seconds.
    pub elapsed_secs: u64,
}

impl CompilationEvent for FilesystemSettlingEvent {
    fn type_name(&self) -> &'static str {
        "FilesystemSettlingEvent"
    }

    fn severity(&self) -> Severity {
        Severity::Info
    }

    fn message(&self) -> String {
        format!(
            "Turbopack has seen frequent file updates and is waiting for the filesystem to settle \
             ({}s elapsed).",
            self.elapsed_secs
        )
    }

    fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap()
    }
}

/// Invalidation was caused by a watcher rescan event. This will likely invalidate *every* watched
/// file.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct InvalidateRescan {
    path: RcStr,
}

impl InvalidationReason for InvalidateRescan {
    fn kind(&self) -> Option<StaticOrArc<dyn InvalidationReasonKind>> {
        Some(StaticOrArc::Static(&INVALIDATE_RESCAN_KIND))
    }
}

impl fmt::Display for InvalidateRescan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} in filesystem invalidated", self.path)
    }
}

/// [Invalidation kind][InvalidationReasonKind] for [`InvalidateRescan`].
#[derive(PartialEq, Eq, Hash)]
struct InvalidateRescanKind;

static INVALIDATE_RESCAN_KIND: InvalidateRescanKind = InvalidateRescanKind;

impl InvalidationReasonKind for InvalidateRescanKind {
    fn fmt(
        &self,
        reasons: &FxIndexSet<StaticOrArc<dyn InvalidationReason>>,
        f: &mut fmt::Formatter<'_>,
    ) -> fmt::Result {
        let first_reason: &dyn InvalidationReason = &*reasons[0];
        write!(
            f,
            "{} items in filesystem invalidated due to notify::Watcher rescan event ({}, ...)",
            reasons.len(),
            (first_reason as &dyn Any)
                .downcast_ref::<InvalidateRescan>()
                .unwrap()
                .path
        )
    }
}
