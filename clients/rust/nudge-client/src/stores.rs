use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nudge_protocol::*;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::watch;
use tokio::time::Instant;

use crate::api::{ApiError, PageRequest};
use crate::cache::Cache;
use crate::connection::{Subscriber, TargetFrame};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncStatus {
    /// Until a snapshot arrives, and again after a drop or a gap.
    Syncing,
    Live,
    /// The server stopped sending the view; see `reason`.
    Gone,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ViewState<V> {
    pub status: SyncStatus,
    /// The latest view; kept, though possibly stale, while a new snapshot is on its way. Also
    /// the cached view from the last run, until the first snapshot.
    pub view: Option<Arc<V>>,
    /// Why the server stopped sending the view: not a room of this player, or no longer.
    pub reason: Option<UnsubscribedReason>,
    /// The last snapshot couldn't be read as a view.
    pub error: Option<String>,
}

impl<V> Default for ViewState<V> {
    fn default() -> Self {
        ViewState {
            status: SyncStatus::Syncing,
            view: None,
            reason: None,
            error: None,
        }
    }
}

/// How often at most a view that changes by patches is written to the cache.
const SAVE_EVERY: Duration = Duration::from_secs(2);

/// One target's view, kept up to date from its snapshot and patches, and saved to the cache.
struct Core<V: Serialize> {
    target: Target,
    seq: Option<u64>,
    /// The view as JSON, which patches apply to.
    raw: Option<Value>,
    state: ViewState<V>,
    cache: Arc<Cache>,
    saved_at: Option<Instant>,
    /// The view changed since it was last saved.
    unsaved: bool,
}

impl<V: Serialize> Drop for Core<V> {
    fn drop(&mut self) {
        if self.unsaved {
            self.write();
        }
    }
}

impl<V: DeserializeOwned + Serialize> Core<V> {
    fn new(target: Target, cache: Arc<Cache>) -> Self {
        let cached = cache
            .view(&target)
            .and_then(|text| serde_json::from_str::<V>(&text).ok());
        let state = ViewState {
            view: cached.map(Arc::new),
            ..ViewState::default()
        };
        Core {
            target,
            seq: None,
            raw: None,
            state,
            cache,
            saved_at: None,
            unsaved: false,
        }
    }

    /// Takes a frame; false when it doesn't follow on. Returns whether the state changed too.
    fn receive(&mut self, frame: TargetFrame) -> (bool, bool) {
        match frame {
            TargetFrame::Snapshot { seq, view } => {
                match V::deserialize(&view) {
                    Ok(typed) => {
                        self.seq = Some(seq);
                        self.raw = Some(view);
                        self.state = ViewState {
                            status: SyncStatus::Live,
                            view: Some(Arc::new(typed)),
                            reason: None,
                            error: None,
                        };
                        self.save(true);
                    }
                    // Subscribing again would bring the same: wait, showing why.
                    Err(error) => {
                        self.seq = None;
                        self.raw = None;
                        self.state.status = SyncStatus::Syncing;
                        self.state.error = Some(error.to_string());
                    }
                }
                (true, true)
            }
            TargetFrame::Patch { seq, ops } => {
                // Patches of a subscription replaced by one already asked for.
                let Some(last) = self.seq else {
                    return (true, false);
                };
                let Some(raw) = self.raw.as_mut().filter(|_| seq == last + 1) else {
                    return (false, self.lose());
                };
                if apply_in_place(raw, &ops).is_err() {
                    return (false, self.lose());
                }
                match V::deserialize(&*raw) {
                    Ok(typed) => {
                        self.seq = Some(seq);
                        self.state.view = Some(Arc::new(typed));
                        self.save(false);
                        (true, true)
                    }
                    Err(_) => (false, self.lose()),
                }
            }
            TargetFrame::Unsubscribed { reason } => {
                self.seq = None;
                self.raw = None;
                self.state.status = SyncStatus::Gone;
                self.state.reason = Some(reason);
                self.cache.forget_view(&self.target);
                (true, true)
            }
        }
    }

    /// Waits for a new snapshot; returns whether the state changed.
    fn resync(&mut self) -> bool {
        self.seq = None;
        self.raw = None;
        if self.state.status != SyncStatus::Live {
            return false;
        }
        self.state.status = SyncStatus::Syncing;
        self.save(true);
        true
    }

    fn lose(&mut self) -> bool {
        self.resync()
    }

    /// Saves the view `now`, or when it wasn't saved for `SAVE_EVERY`; else when the store goes.
    fn save(&mut self, now: bool) {
        if now || self.saved_at.is_none_or(|at| at.elapsed() >= SAVE_EVERY) {
            self.write();
        } else {
            self.unsaved = true;
        }
    }
}

impl<V: Serialize> Core<V> {
    fn write(&mut self) {
        if let Some(view) = &self.state.view
            && let Ok(text) = serde_json::to_string(&**view)
        {
            self.cache.save_view(&self.target, &text);
            self.saved_at = Some(Instant::now());
            self.unsaved = false;
        }
    }
}

/// The player's room list. `state` is a new value on every change, and `states` hears of each.
pub struct RoomListStore {
    core: Mutex<Core<RoomListView>>,
    sender: watch::Sender<Arc<ViewState<RoomListView>>>,
}

impl RoomListStore {
    pub fn new(cache: Arc<Cache>) -> Self {
        let core = Core::new(Target::RoomList, cache);
        let sender = watch::Sender::new(Arc::new(core.state.clone()));
        RoomListStore {
            core: Mutex::new(core),
            sender,
        }
    }

    pub fn state(&self) -> Arc<ViewState<RoomListView>> {
        self.sender.borrow().clone()
    }

    pub fn states(&self) -> watch::Receiver<Arc<ViewState<RoomListView>>> {
        self.sender.subscribe()
    }

    fn publish(&self, core: &Core<RoomListView>) {
        self.sender.send_replace(Arc::new(core.state.clone()));
    }
}

impl Subscriber for RoomListStore {
    fn receive(&self, frame: TargetFrame) -> bool {
        let mut core = self.core.lock().unwrap();
        let (follows, changed) = core.receive(frame);
        if changed {
            self.publish(&core);
        }
        follows
    }

    fn resync(&self) {
        let mut core = self.core.lock().unwrap();
        if core.resync() {
            self.publish(&core);
        }
    }
}

/// A message this client sent that the room's view doesn't show yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingMessage {
    pub request_id: String,
    pub text: String,
    pub when_busy: Option<WhenBusy>,
    /// Only the sender sees it and the answer to it.
    pub private: bool,
    pub state: PendingState,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PendingState {
    /// On its way, or sent and not in the view yet.
    Sending,
    /// It didn't get through; it is sent again once the socket is open.
    Waiting { error: String },
    /// The server refused it; `resend` tries again with the same request id, `dismiss` drops it.
    Failed { error: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct RoomState {
    pub status: SyncStatus,
    pub view: Option<Arc<RoomView>>,
    pub reason: Option<UnsubscribedReason>,
    pub error: Option<String>,
    /// `earlier`, then the view's timeline: everything to show, oldest first.
    pub timeline: Arc<Vec<TimelineItem>>,
    /// Items older than the view's: pages loaded, and items that slid out of the view's window.
    pub earlier: Arc<Vec<TimelineItem>>,
    pub can_load_earlier: bool,
    pub loading_earlier: bool,
    pub earlier_error: Option<String>,
    /// Messages this client sent that are neither in the timeline nor queued yet, oldest first.
    pub pending: Arc<Vec<PendingMessage>>,
}

/// Fetches a page of the room's history, as `GET /rooms/<id>/timeline` does.
pub type PageLoader = Arc<
    dyn Fn(PageRequest) -> Pin<Box<dyn Future<Output = Result<TimelineResponse, ApiError>> + Send>>
        + Send
        + Sync,
>;

/// A room's view, plus what the client keeps beside it: older items, from `/timeline` pages and
/// from the head of the view's window as it slides, and the messages it sent that the view
/// doesn't show yet. A user item or queued message with the same request id replaces a pending
/// one, and takes it out of the outbox.
pub struct RoomStore {
    id: String,
    pages: Option<PageLoader>,
    inner: Mutex<RoomInner>,
    sender: watch::Sender<Arc<RoomState>>,
}

struct RoomInner {
    core: Core<RoomView>,
    earlier: Arc<Vec<TimelineItem>>,
    /// The next page's cursor; `None` for the page just before the view.
    before: Option<String>,
    reached_start: bool,
    loading: bool,
    earlier_error: Option<String>,
    /// Bumped whenever `earlier` starts over, so a page fetched before then is dropped.
    generation: u64,
    pending: Arc<Vec<PendingMessage>>,
    timeline: Arc<Vec<TimelineItem>>,
}

impl RoomStore {
    pub fn new(id: &str, cache: Arc<Cache>, pages: Option<PageLoader>) -> Self {
        let core = Core::new(Target::Room(id.to_owned()), cache);
        let mut inner = RoomInner {
            core,
            earlier: Arc::default(),
            before: None,
            reached_start: false,
            loading: false,
            earlier_error: None,
            generation: 0,
            pending: Arc::default(),
            timeline: Arc::default(),
        };
        inner.timeline = inner.join();
        let state = Arc::new(inner.state(pages.is_some()));
        RoomStore {
            id: id.to_owned(),
            pages,
            inner: Mutex::new(inner),
            sender: watch::Sender::new(state),
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn state(&self) -> Arc<RoomState> {
        self.sender.borrow().clone()
    }

    pub fn states(&self) -> watch::Receiver<Arc<RoomState>> {
        self.sender.subscribe()
    }

    /// Shows `message` as pending until the view has it.
    pub(crate) fn sending(&self, message: PendingMessage) {
        self.change(|inner| {
            let mut pending: Vec<PendingMessage> = inner
                .pending
                .iter()
                .filter(|p| p.request_id != message.request_id)
                .cloned()
                .collect();
            pending.push(message);
            inner.pending = Arc::new(pending);
        });
    }

    pub(crate) fn set_pending(&self, request_id: &str, state: PendingState) {
        self.change(|inner| {
            if !inner.pending.iter().any(|p| p.request_id == request_id) {
                return;
            }
            let pending = inner
                .pending
                .iter()
                .map(|p| {
                    if p.request_id == request_id {
                        PendingMessage {
                            state: state.clone(),
                            ..p.clone()
                        }
                    } else {
                        p.clone()
                    }
                })
                .collect();
            inner.pending = Arc::new(pending);
        });
    }

    /// Stops showing a pending message.
    pub(crate) fn dismiss(&self, request_id: &str) {
        self.change(|inner| {
            if inner.pending.iter().any(|p| p.request_id == request_id) {
                inner.pending = Arc::new(
                    inner
                        .pending
                        .iter()
                        .filter(|p| p.request_id != request_id)
                        .cloned()
                        .collect(),
                );
            }
        });
    }

    pub(crate) fn pending(&self, request_id: &str) -> Option<PendingMessage> {
        self.inner
            .lock()
            .unwrap()
            .pending
            .iter()
            .find(|p| p.request_id == request_id)
            .cloned()
    }

    /// Fetches the page before `earlier`; does nothing while one is loading or at the start.
    pub async fn load_earlier(&self, limit: Option<u32>) {
        let Some(pages) = self.pages.clone() else {
            return;
        };
        let (generation, before) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.loading || !inner.can_load_earlier(true) {
                return;
            }
            inner.loading = true;
            inner.earlier_error = None;
            self.publish(&mut inner);
            (inner.generation, inner.before.clone())
        };
        let page = pages(PageRequest { before, limit }).await;
        let mut inner = self.inner.lock().unwrap();
        if generation != inner.generation {
            return;
        }
        match page {
            Ok(page) => {
                // A page fetched without a cursor ends at the view's window, so it may hold slid
                // items.
                let view = inner.core.state.view.clone();
                let known: HashSet<&str> = inner
                    .earlier
                    .iter()
                    .chain(view.iter().flat_map(|view| view.timeline.iter()))
                    .filter_map(TimelineItem::id)
                    .collect();
                let mut earlier: Vec<TimelineItem> = page
                    .items
                    .into_iter()
                    .filter(|item| item.id().is_some_and(|id| !known.contains(id)))
                    .collect();
                earlier.extend(inner.earlier.iter().cloned());
                inner.earlier = Arc::new(earlier);
                inner.reached_start = page.before.is_none();
                inner.before = page.before;
            }
            Err(error) => inner.earlier_error = Some(error.to_string()),
        }
        inner.loading = false;
        self.publish(&mut inner);
    }

    fn change(&self, change: impl FnOnce(&mut RoomInner)) {
        let mut inner = self.inner.lock().unwrap();
        change(&mut inner);
        self.publish(&mut inner);
    }

    fn publish(&self, inner: &mut RoomInner) {
        inner.timeline = inner.join();
        self.sender
            .send_replace(Arc::new(inner.state(self.pages.is_some())));
    }

    /// After the view changed from `before`: slides `earlier`, and drops pending messages the
    /// view now shows.
    fn view_changed(&self, inner: &mut RoomInner, before: Option<Arc<RoomView>>) {
        let after = inner.core.state.view.clone();
        if let (Some(before), Some(after)) = (&before, &after)
            && !Arc::ptr_eq(before, after)
        {
            match slide(&inner.earlier, &before.timeline, &after.timeline) {
                Some(earlier) => inner.earlier = earlier,
                None => inner.start_over(),
            }
        }
        if let Some(view) = &after {
            let seen = seen(view);
            if inner
                .pending
                .iter()
                .any(|p| seen.contains(p.request_id.as_str()))
            {
                for message in inner
                    .pending
                    .iter()
                    .filter(|p| seen.contains(p.request_id.as_str()))
                {
                    inner.core.cache.remove_outgoing(&message.request_id);
                }
                inner.pending = Arc::new(
                    inner
                        .pending
                        .iter()
                        .filter(|p| !seen.contains(p.request_id.as_str()))
                        .cloned()
                        .collect(),
                );
            }
        }
    }
}

impl Subscriber for RoomStore {
    fn receive(&self, frame: TargetFrame) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let before = inner.core.state.view.clone();
        let (follows, changed) = inner.core.receive(frame);
        if changed {
            self.view_changed(&mut inner, before);
            self.publish(&mut inner);
        }
        follows
    }

    fn resync(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.core.resync() {
            self.publish(&mut inner);
        }
    }
}

impl RoomInner {
    fn start_over(&mut self) {
        self.earlier = Arc::default();
        self.before = None;
        self.reached_start = false;
        self.loading = false;
        self.earlier_error = None;
        self.generation += 1;
    }

    fn can_load_earlier(&self, has_pages: bool) -> bool {
        has_pages
            && !self.reached_start
            && self
                .core
                .state
                .view
                .as_ref()
                .is_some_and(|view| view.has_earlier)
    }

    /// `earlier` and the view's timeline, joined; the same `Arc` while neither changed.
    fn join(&self) -> Arc<Vec<TimelineItem>> {
        let view = self.core.state.view.as_ref().map(|view| &view.timeline);
        let length = self.earlier.len() + view.map_or(0, Vec::len);
        let same = self.timeline.len() == length
            && self
                .timeline
                .iter()
                .zip(self.earlier.iter().chain(view.into_iter().flatten()))
                .all(|(a, b)| a == b);
        if same {
            return self.timeline.clone();
        }
        Arc::new(
            self.earlier
                .iter()
                .chain(view.into_iter().flatten())
                .cloned()
                .collect(),
        )
    }

    fn state(&self, has_pages: bool) -> RoomState {
        let core = &self.core.state;
        RoomState {
            status: core.status,
            view: core.view.clone(),
            reason: core.reason,
            error: core.error.clone(),
            timeline: self.timeline.clone(),
            earlier: self.earlier.clone(),
            can_load_earlier: self.can_load_earlier(has_pages),
            loading_earlier: self.loading,
            earlier_error: self.earlier_error.clone(),
            pending: self.pending.clone(),
        }
    }
}

/// `earlier` after the view's window moved from `before` to `after`: items that left its head
/// are added, newest last. `None` when the windows don't overlap, so items between them may be
/// missing (after a long time offline, say): `earlier` then starts over.
pub fn slide(
    earlier: &Arc<Vec<TimelineItem>>,
    before: &[TimelineItem],
    after: &[TimelineItem],
) -> Option<Arc<Vec<TimelineItem>>> {
    let (Some(first), Some(head)) = (before.first(), after.first()) else {
        return Some(earlier.clone());
    };
    let in_after: HashSet<&str> = after.iter().filter_map(TimelineItem::id).collect();
    let left: &[TimelineItem] = if first.id().is_some_and(|id| in_after.contains(id)) {
        &[]
    } else {
        let start = before
            .iter()
            .position(|item| item.id().is_some() && item.id() == head.id())?;
        &before[..start]
    };
    let in_after_id = |item: &TimelineItem| item.id().is_some_and(|id| in_after.contains(id));
    if left.is_empty() && !earlier.iter().any(in_after_id) {
        return Some(earlier.clone());
    }
    let known: HashSet<&str> = earlier.iter().filter_map(TimelineItem::id).collect();
    let added = left
        .iter()
        .filter(|item| item.id().is_some_and(|id| !known.contains(id)));
    Some(Arc::new(
        earlier
            .iter()
            .chain(added)
            .filter(|item| !in_after_id(item))
            .cloned()
            .collect(),
    ))
}

/// The request ids of the user items and queued messages in `view`.
fn seen(view: &RoomView) -> HashSet<&str> {
    let mut seen = HashSet::new();
    for item in &view.timeline {
        if let TimelineItem::User(UserItem {
            request_id: Some(id),
            ..
        }) = item
        {
            seen.insert(id.as_str());
        }
    }
    for queued in &view.queue {
        if let Some(id) = &queued.request_id {
            seen.insert(id.as_str());
        }
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::oneshot;

    fn user(n: usize) -> TimelineItem {
        TimelineItem::User(UserItem {
            id: format!("m{n}"),
            text: format!("Message {n}"),
            author: None,
            sent_at: None,
            client_id: None,
            request_id: None,
            private_to: None,
            attachments: None,
            press: None,
        })
    }

    fn users(from: usize, to: usize) -> Vec<TimelineItem> {
        (from..to).map(user).collect()
    }

    fn ids(items: &[TimelineItem]) -> Vec<&str> {
        items.iter().filter_map(TimelineItem::id).collect()
    }

    fn room_view(timeline: Vec<TimelineItem>) -> RoomView {
        RoomView {
            room: Room {
                id: "trip".into(),
                kind: RoomKind::Shared,
                name: "Trip".into(),
                members: vec![],
                images_to_model: None,
            },
            timeline,
            has_earlier: true,
            live: Live {
                running: false,
                status: None,
            },
            queue: vec![],
            approvals: vec![],
            memory: vec![],
            nudges: vec![],
            sharing_location: None,
        }
    }

    fn snapshot(view: &RoomView) -> TargetFrame {
        TargetFrame::Snapshot {
            seq: 0,
            view: serde_json::to_value(view).unwrap(),
        }
    }

    fn patch(seq: u64, ops: Value) -> TargetFrame {
        TargetFrame::Patch {
            seq,
            ops: serde_json::from_value(ops).unwrap(),
        }
    }

    fn store(pages: Option<PageLoader>) -> RoomStore {
        RoomStore::new("trip", Arc::new(Cache::in_memory()), pages)
    }

    fn loader(
        pages: impl Fn(PageRequest) -> TimelineResponse + Send + Sync + 'static,
    ) -> PageLoader {
        let pages = Arc::new(pages);
        Arc::new(move |request| {
            let pages = pages.clone();
            Box::pin(async move { Ok(pages(request)) })
        })
    }

    #[test]
    fn rebuild_every_recorded_view_from_the_recorded_frames() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/protocol/test/fixtures/room-stream.jsonl"
        );
        let cache = Arc::new(Cache::in_memory());
        let room_list = RoomListStore::new(cache.clone());
        let room = RoomStore::new("trip", cache.clone(), None);
        let mut checked = 0;
        for line in std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter(|line| !line.is_empty())
        {
            let line: Value = serde_json::from_str(line).unwrap();
            let frame = match serde_json::from_value::<ServerFrame>(line["frame"].clone()).unwrap()
            {
                ServerFrame::Snapshot { target, seq, view } => {
                    (target, TargetFrame::Snapshot { seq, view })
                }
                ServerFrame::Patch { target, seq, ops } => {
                    (target, TargetFrame::Patch { seq, ops })
                }
                _ => continue,
            };
            match frame {
                (Target::RoomList, frame) => {
                    assert!(room_list.receive(frame));
                    let state = room_list.state();
                    assert_eq!(state.status, SyncStatus::Live);
                    let expected: RoomListView =
                        serde_json::from_value(line["view"].clone()).unwrap();
                    assert_eq!(state.view.as_deref(), Some(&expected));
                }
                (Target::Room(_), frame) => {
                    assert!(room.receive(frame));
                    let state = room.state();
                    assert_eq!(state.status, SyncStatus::Live);
                    let expected: RoomView = serde_json::from_value(line["view"].clone()).unwrap();
                    assert_eq!(state.view.as_deref(), Some(&expected));
                    assert_eq!(*state.timeline, expected.timeline);
                }
            }
            checked += 1;
        }
        assert!(checked > 4);
        // The cache has the latest views for the next run, once the stores are gone.
        let (room_list_view, room_view) =
            (room_list.state().view.clone(), room.state().view.clone());
        drop((room_list, room));
        assert_eq!(
            RoomListStore::new(cache.clone()).state().view,
            room_list_view
        );
        assert_eq!(RoomStore::new("trip", cache, None).state().view, room_view);
    }

    #[test]
    fn ask_for_a_new_snapshot_on_a_gap_or_a_patch_that_does_not_fit() {
        let store = store(None);
        let mut states = store.states();
        let mut heard = 0;
        let mut count = |states: &mut watch::Receiver<Arc<RoomState>>| {
            if states.has_changed().unwrap() {
                states.mark_unchanged();
                heard += 1;
            }
        };
        let append = |seq| {
            patch(
                seq,
                json!([{ "op": "append", "path": ["timeline", 0, "text"], "text": "!" }]),
            )
        };
        assert!(store.receive(snapshot(&room_view(vec![user(0)]))));
        count(&mut states);
        assert!(store.receive(append(1)));
        count(&mut states);
        let text = |store: &RoomStore| match &store.state().view.as_ref().unwrap().timeline[0] {
            TimelineItem::User(item) => item.text.clone(),
            _ => unreachable!(),
        };
        assert_eq!(text(&store), "Message 0!");

        assert!(!store.receive(append(3)));
        count(&mut states);
        assert_eq!(store.state().status, SyncStatus::Syncing);
        assert_eq!(
            text(&store),
            "Message 0!",
            "the last view stays while syncing"
        );
        // Still the old subscription's patches: dropped until the snapshot.
        assert!(store.receive(append(4)));
        assert!(!states.has_changed().unwrap());
        assert!(store.receive(snapshot(&room_view(vec![user(0)]))));
        count(&mut states);
        let bad = patch(
            1,
            json!([{ "op": "append", "path": ["timeline", 5, "text"], "text": "?" }]),
        );
        assert!(!store.receive(bad));
        count(&mut states);
        assert_eq!(store.state().status, SyncStatus::Syncing);

        store.receive(TargetFrame::Unsubscribed {
            reason: UnsubscribedReason::Removed,
        });
        count(&mut states);
        assert_eq!(store.state().status, SyncStatus::Gone);
        assert_eq!(store.state().reason, Some(UnsubscribedReason::Removed));
        assert_eq!(heard, 6);
    }

    #[test]
    fn keep_items_that_slide_out_of_the_window() {
        let store = store(None);
        store.receive(snapshot(&room_view(users(0, 4))));
        store.receive(patch(
            1,
            json!([
                { "op": "splice", "path": ["timeline"], "index": 0, "remove": 2, "insert": [] },
                { "op": "splice", "path": ["timeline"], "index": 2, "remove": 0, "insert": serde_json::to_value(users(4, 6)).unwrap() },
            ]),
        ));
        assert_eq!(ids(&store.state().earlier), ["m0", "m1"]);
        assert_eq!(ids(&store.state().timeline), ids(&users(0, 6)));
        // Reconnected, and the window moved on with a gap: the old items can't join, so they go.
        store.resync();
        store.receive(snapshot(&room_view(users(10, 12))));
        assert!(store.state().earlier.is_empty());
    }

    #[test]
    fn slide_joins_overlapping_windows_and_gives_up_on_ones_that_do_not() {
        let slid = |earlier: Vec<TimelineItem>, before, after| {
            slide(&Arc::new(earlier), &users_of(before), &users_of(after))
                .map(|e| ids(&e).into_iter().map(str::to_owned).collect::<Vec<_>>())
        };
        fn users_of((from, to): (usize, usize)) -> Vec<TimelineItem> {
            users(from, to)
        }
        assert_eq!(slid(vec![], (0, 3), (1, 4)), Some(vec!["m0".into()]));
        assert_eq!(slid(vec![user(0)], (1, 3), (1, 4)), Some(vec!["m0".into()]));
        assert_eq!(slid(vec![user(0)], (1, 3), (0, 4)), Some(vec![]));
        assert_eq!(slid(vec![], (0, 3), (5, 6)), None);
        assert_eq!(slid(vec![user(0)], (0, 0), (5, 6)), Some(vec!["m0".into()]));
    }

    #[test]
    fn show_pending_messages_until_the_timeline_or_the_queue_has_them() {
        let cache = Arc::new(Cache::in_memory());
        let store = RoomStore::new("trip", cache.clone(), None);
        store.receive(snapshot(&RoomView {
            has_earlier: false,
            ..room_view(vec![])
        }));
        let message = |id: &str, text: &str| PendingMessage {
            request_id: id.into(),
            text: text.into(),
            when_busy: None,
            private: false,
            state: PendingState::Sending,
        };
        for (id, text) in [("r1", "Hello"), ("r2", "Again")] {
            cache.add_outgoing(&crate::Outgoing {
                request_id: id.into(),
                room: "trip".into(),
                text: text.into(),
                when_busy: None,
                private: false,
                created_at: 0,
                error: None,
            });
            store.sending(message(id, text));
        }
        store.set_pending(
            "r2",
            PendingState::Failed {
                error: "Not allowed".into(),
            },
        );
        assert_eq!(
            *store.state().pending,
            [
                message("r1", "Hello"),
                PendingMessage {
                    state: PendingState::Failed {
                        error: "Not allowed".into()
                    },
                    ..message("r2", "Again")
                }
            ]
        );
        store.receive(patch(
            1,
            json!([{ "op": "set", "path": ["queue"], "value": [{ "id": 1, "mode": "followUp", "text": "Hello", "requestId": "r1", "nudge": false }] }]),
        ));
        assert_eq!(
            store
                .state()
                .pending
                .iter()
                .map(|p| p.request_id.as_str())
                .collect::<Vec<_>>(),
            ["r2"]
        );
        // The view has it, so the outbox doesn't need it any more.
        assert_eq!(
            cache
                .outbox(None)
                .iter()
                .map(|m| m.request_id.as_str())
                .collect::<Vec<_>>(),
            ["r2"]
        );
        store.dismiss("r2");
        assert!(store.state().pending.is_empty());
    }

    #[tokio::test]
    async fn load_earlier_pages_back_to_the_start_without_repeating_slid_items() {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let log = asked.clone();
        let (open, gate) = oneshot::channel::<()>();
        let gate = Arc::new(tokio::sync::Mutex::new(Some(gate)));
        let pages: PageLoader = Arc::new(move |request: PageRequest| {
            log.lock().unwrap().push(request.before.clone());
            let gate = gate.clone();
            Box::pin(async move {
                if let Some(gate) = gate.lock().await.take() {
                    let _ = gate.await;
                }
                Ok(match request.before.as_deref() {
                    None => TimelineResponse {
                        items: users(1, 4),
                        before: Some("c1".into()),
                    },
                    Some(_) => TimelineResponse {
                        items: users(0, 1),
                        before: None,
                    },
                })
            })
        });
        let store = Arc::new(store(Some(pages)));
        store.receive(snapshot(&room_view(users(3, 6))));
        store.receive(patch(1, json!([{ "op": "splice", "path": ["timeline"], "index": 0, "remove": 1, "insert": [] }])));
        assert!(store.state().can_load_earlier);
        assert_eq!(ids(&store.state().earlier), ["m3"]);

        let loading = tokio::spawn({
            let store = store.clone();
            async move { store.load_earlier(None).await }
        });
        while !store.state().loading_earlier {
            tokio::task::yield_now().await;
        }
        store.load_earlier(None).await; // Already loading: no second request.
        open.send(()).unwrap();
        loading.await.unwrap();
        store.load_earlier(None).await;
        assert_eq!(*asked.lock().unwrap(), [None, Some("c1".to_owned())]);
        let state = store.state();
        assert!(!state.can_load_earlier && !state.loading_earlier);
        assert_eq!(ids(&state.timeline), ids(&users(0, 6)));
    }

    #[tokio::test]
    async fn drop_a_page_that_arrives_after_the_earlier_items_started_over() {
        let (answer, page) = oneshot::channel::<TimelineResponse>();
        let page = Arc::new(tokio::sync::Mutex::new(Some(page)));
        let pages: PageLoader = Arc::new(move |_| {
            let page = page.clone();
            Box::pin(async move { Ok(page.lock().await.take().unwrap().await.unwrap()) })
        });
        let store = Arc::new(store(Some(pages)));
        store.receive(snapshot(&room_view(users(5, 8))));
        let loading = tokio::spawn({
            let store = store.clone();
            async move { store.load_earlier(None).await }
        });
        while !store.state().loading_earlier {
            tokio::task::yield_now().await;
        }
        store.resync();
        store.receive(snapshot(&room_view(users(20, 22))));
        answer
            .send(TimelineResponse {
                items: users(0, 5),
                before: Some("c".into()),
            })
            .unwrap();
        loading.await.unwrap();
        let state = store.state();
        assert!(state.earlier.is_empty() && !state.loading_earlier);
        let _ = loader(|_| TimelineResponse {
            items: vec![],
            before: None,
        });
    }
}
