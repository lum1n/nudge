//! These hand-written types against `packages/protocol/schema/v1.json`, the TypeBox schemas
//! written out: every type, with every optional field set, must validate against its schema and
//! use exactly the keys the schema names, so a field renamed, added or dropped on either side
//! fails here.

use std::sync::LazyLock;

use nudge_protocol::*;
use serde::Serialize;
use serde_json::{Map, Value, json};

static SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/schema/v1.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
});

fn def(name: &str) -> &'static Value {
    SCHEMA["$defs"]
        .get(name)
        .unwrap_or_else(|| panic!("no {name} in schema/v1.json"))
}

/// `value` serialized validates against the schema `name`, has all of its keys and no others,
/// and reads back as itself.
fn check<T>(name: &str, value: &T)
where
    T: Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let json = serde_json::to_value(value).unwrap();
    let schema = def(name);
    let validator = jsonschema::validator_for(schema).unwrap();
    let errors: Vec<String> = validator
        .iter_errors(&json)
        .map(|e| format!("{e} at {}", e.instance_path()))
        .collect();
    assert!(errors.is_empty(), "{name}: {json} is not valid: {errors:?}");
    same_keys(name, schema, &json);
    assert_eq!(
        &serde_json::from_value::<T>(json).unwrap(),
        value,
        "{name} reads back"
    );
}

/// Every object in `value` has exactly the keys its schema lists.
fn same_keys(at: &str, schema: &Value, value: &Value) {
    if let Some(variants) = schema.get("anyOf").and_then(Value::as_array) {
        let variant = variants
            .iter()
            .find(|variant| fits(variant, value))
            .unwrap_or_else(|| panic!("{at}: no variant for {value}"));
        return same_keys(at, variant, value);
    }
    match value {
        Value::Object(map) => {
            let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
                return; // A record, such as a tool's args.
            };
            let mut ours: Vec<&String> = map.keys().collect();
            let mut theirs: Vec<&String> = properties.keys().collect();
            ours.sort();
            theirs.sort();
            assert_eq!(ours, theirs, "{at}: keys differ from the schema");
            for (key, child) in map {
                same_keys(&format!("{at}.{key}"), &properties[key], child);
            }
        }
        Value::Array(items) => {
            if let Some(item) = schema.get("items") {
                for (index, child) in items.iter().enumerate() {
                    same_keys(&format!("{at}[{index}]"), item, child);
                }
            }
        }
        _ => {}
    }
}

/// Whether `value` is the variant `schema`: valid, and for objects, with its constant keys.
fn fits(schema: &Value, value: &Value) -> bool {
    let constants = match (value, schema.get("properties").and_then(Value::as_object)) {
        (Value::Object(map), Some(properties)) => {
            properties
                .iter()
                .all(|(key, property)| match property.get("const") {
                    Some(constant) => map.get(key) == Some(constant),
                    None => true,
                })
        }
        _ => true,
    };
    constants && jsonschema::validator_for(schema).unwrap().is_valid(value)
}

fn ann() -> Player {
    Player {
        id: "ann".into(),
        display_name: "Ann".into(),
    }
}

fn room() -> Room {
    Room {
        id: "trip".into(),
        kind: RoomKind::Shared,
        name: "Trip".into(),
        members: vec![ann()],
    }
}

fn tool() -> ToolPart {
    let mut args = Map::new();
    args.insert("task".into(), json!("look"));
    ToolPart {
        call_id: "c1".into(),
        name: "browse".into(),
        args,
        status: ToolStatus::Done,
        result: Some("ok".into()),
        is_error: Some(false),
        details: Some(json!({ "login": true })),
        output: Some("…".into()),
        truncated: Some(true),
    }
}

fn items() -> Vec<TimelineItem> {
    vec![
        TimelineItem::User(UserItem {
            id: "user:1".into(),
            text: "Hi".into(),
            author: Some(ann()),
            sent_at: Some(1.0),
            client_id: Some("client-1".into()),
            request_id: Some("r1".into()),
            private_to: Some(ann()),
        }),
        TimelineItem::Nudge(NudgeItem {
            id: "nudge:2".into(),
            text: "Time".into(),
            fired_at: 2.0,
            private_to: Some(ann()),
        }),
        TimelineItem::Approval(ApprovalItem {
            id: "approval:3".into(),
            approval_id: "a1".into(),
            summary: "Pay".into(),
            status: ApprovalStatus::Denied,
            decided_by: Some("Ann".into()),
            private_to: Some(ann()),
        }),
        TimelineItem::Answer(AnswerItem {
            id: "answer:4".into(),
            status: AnswerStatus::Failed,
            error: Some("boom".into()),
            parts: vec![
                Part::Text { text: "a".into() },
                Part::Reasoning { text: "b".into() },
                Part::Tool(tool()),
            ],
            private_to: Some(ann()),
        }),
        TimelineItem::Marker(MarkerItem {
            id: "marker:5".into(),
            kind: MarkerKind::Compacted,
        }),
    ]
}

fn room_view() -> RoomView {
    RoomView {
        room: room(),
        timeline: items(),
        has_earlier: true,
        live: Live {
            running: true,
            status: Some(Status::Retrying {
                attempt: 2,
                at: 3.0,
                error: "busy".into(),
            }),
        },
        queue: vec![QueuedMessage {
            id: 7,
            mode: QueueMode::FollowUp,
            text: "next".into(),
            author: Some(ann()),
            client_id: Some("client-1".into()),
            request_id: Some("r2".into()),
            nudge: false,
            private_to: Some(ann()),
        }],
        approvals: vec![Approval {
            id: "a1".into(),
            summary: "Pay".into(),
            status: ApprovalStatus::Done,
            requested_at: 1.0,
            decided_by: Some(ann()),
            decided_at: Some(2.0),
            result: Some("paid".into()),
            private_to: Some(ann()),
        }],
        memory: vec![Fact {
            id: "f1".into(),
            text: "Likes tea".into(),
            created_at: 1.0,
            by: Some(ann()),
            owner: Some(ann()),
            private_to: Some(ann()),
        }],
        nudges: vec![RoomNudge {
            id: "n1".into(),
            message: "Water".into(),
            fire_at: 5.0,
            every: Some(60_000.0),
            private_to: Some(ann()),
        }],
    }
}

fn home_view() -> HomeView {
    HomeView {
        player: ann(),
        rooms: vec![HomeRoom {
            room: room(),
            running: false,
            pending_approvals: 1,
            last_item_at: Some(4.0),
        }],
        nudges: vec![HomeNudge {
            id: "n1".into(),
            room_id: "trip".into(),
            message: "Water".into(),
            fire_at: 5.0,
            every: Some(60_000.0),
            private_to: Some(ann()),
        }],
    }
}

#[test]
fn views_match_the_schema() {
    check("Player", &ann());
    check("Room", &room());
    check("Part", &Part::Tool(tool()));
    for item in items() {
        check("TimelineItem", &item);
    }
    for status in [
        Status::Compacting,
        Status::CompactionFailed { error: "x".into() },
    ] {
        check("Status", &status);
    }
    for kind in [RoomKind::Lobby, RoomKind::Personal] {
        check("RoomKind", &kind);
    }
    for status in [
        ApprovalStatus::Pending,
        ApprovalStatus::Approved,
        ApprovalStatus::Failed,
    ] {
        check("ApprovalStatus", &status);
    }
    check("RoomView", &room_view());
    check("HomeView", &home_view());
}

#[test]
fn frames_match_the_schema() {
    let description = ClientDescription {
        name: "nudge-rust".into(),
        version: "0.0.0".into(),
        platform: "linux".into(),
    };
    for frame in [
        ClientFrame::Hello {
            protocol: PROTOCOL_VERSION,
            token: "t".into(),
            client: description,
        },
        ClientFrame::Subscribe {
            target: Target::Home,
        },
        ClientFrame::Unsubscribe {
            target: Target::Room("trip".into()),
        },
        ClientFrame::Ping,
    ] {
        check("ClientFrame", &frame);
    }
    let path = vec![PathKey::Key("timeline".into()), PathKey::Index(0)];
    for frame in [
        ServerFrame::Welcome(Welcome {
            protocol: 1,
            server: ServerInfo {
                version: "1".into(),
            },
            epoch: "e".into(),
            player: ann(),
            client_id: "client-1".into(),
            heartbeat_ms: 25_000,
        }),
        ServerFrame::Snapshot {
            target: Target::Room("trip".into()),
            seq: 0,
            view: serde_json::to_value(room_view()).unwrap(),
        },
        ServerFrame::Snapshot {
            target: Target::Home,
            seq: 0,
            view: serde_json::to_value(home_view()).unwrap(),
        },
        ServerFrame::Patch {
            target: Target::Home,
            seq: 1,
            ops: vec![
                Op::Set {
                    path: path.clone(),
                    value: json!(1),
                },
                Op::Del { path: path.clone() },
                Op::Append {
                    path: path.clone(),
                    text: "x".into(),
                },
                Op::Splice {
                    path,
                    index: 0,
                    remove: 1,
                    insert: vec![json!(2)],
                },
            ],
        },
        ServerFrame::Unsubscribed {
            target: Target::Home,
            reason: UnsubscribedReason::NotFound,
        },
        ServerFrame::Unsubscribed {
            target: Target::Home,
            reason: UnsubscribedReason::Removed,
        },
        ServerFrame::Pong,
        ServerFrame::Error {
            message: "no".into(),
        },
    ] {
        check("ServerFrame", &frame);
    }
}

#[test]
fn http_bodies_match_the_schema() {
    let client = ClientInfo {
        name: "ios".into(),
        platform: "ios".into(),
    };
    check("ErrorResponse", &ErrorResponse { error: "x".into() });
    check(
        "AssistantsResponse",
        &AssistantsResponse {
            assistants: vec![AssistantInfo {
                name: "robin".into(),
                display_name: "Robin".into(),
            }],
        },
    );
    check(
        "PairRequest",
        &PairRequest {
            code: "7K3Q-M9XD".into(),
            client: client.clone(),
        },
    );
    check(
        "PairResponse",
        &PairResponse {
            token: "t".into(),
            client_id: "c".into(),
            player: ann(),
        },
    );
    check(
        "MeResponse",
        &MeResponse {
            player: ann(),
            client_id: "c".into(),
            admin: true,
        },
    );
    check(
        "CreateRoomRequest",
        &CreateRoomRequest {
            name: "Trip".into(),
            members: Some(vec!["bo".into()]),
        },
    );
    check(
        "RenameRoomRequest",
        &RenameRoomRequest {
            name: "Trip".into(),
        },
    );
    for when_busy in [WhenBusy::FollowUp, WhenBusy::Steer, WhenBusy::Reject] {
        check(
            "MessageRequest",
            &MessageRequest {
                text: "Hi".into(),
                request_id: "r1".into(),
                when_busy: Some(when_busy),
                private: Some(true),
            },
        );
    }
    check("MessageResponse", &MessageResponse { submission_id: 3 });
    check(
        "TimelineResponse",
        &TimelineResponse {
            items: items(),
            before: Some("cursor".into()),
        },
    );
    check("RememberRequest", &RememberRequest { text: "x".into() });
    check("DecideRequest", &DecideRequest { approve: true });
    check(
        "PlayerMemoryResponse",
        &PlayerMemoryResponse {
            facts: vec![Fact {
                id: "p1".into(),
                text: "Likes tea".into(),
                created_at: 1.0,
                by: Some(ann()),
                owner: Some(ann()),
                private_to: Some(ann()),
            }],
            shared: true,
        },
    );
    check("ShareMemoryRequest", &ShareMemoryRequest { shared: false });
    let extension = RoomExtension {
        name: "browser".into(),
        version: Some("0.1.0".into()),
        description: Some("Browses the web".into()),
        enabled: false,
        by_default: true,
    };
    check("RoomExtension", &extension);
    check(
        "RoomExtensionsResponse",
        &RoomExtensionsResponse {
            extensions: vec![extension],
        },
    );
    check(
        "SetRoomExtensionRequest",
        &SetRoomExtensionRequest {
            enabled: Some(true),
        },
    );
    check(
        "SetRoomExtensionRequest",
        &SetRoomExtensionRequest { enabled: None },
    );
    let settings = json!({ "maxMegabytes": 5 }).as_object().unwrap().clone();
    let setup = ExtensionSetup {
        from: "./extensions/documents".into(),
        name: Some("documents".into()),
        version: Some("0.1.0".into()),
        description: Some("Documents per room".into()),
        configured: true,
        enabled: true,
        rooms: Some(vec![RoomKind::Personal, RoomKind::Shared]),
        settings: settings.clone(),
        schema: Some(json!({ "type": "object", "properties": {} })),
        missing_env: vec!["MAIL_PASSWORD".into()],
        error: Some("Cannot find module".into()),
    };
    check("ExtensionSetup", &setup);
    check(
        "ExtensionSetupsResponse",
        &ExtensionSetupsResponse {
            extensions: vec![setup],
        },
    );
    check(
        "SaveExtensionSetupsRequest",
        &SaveExtensionSetupsRequest {
            extensions: vec![SavedExtensionSetup {
                from: "./extensions/documents".into(),
                enabled: false,
                settings: Some(settings),
                rooms: Some(vec![RoomKind::Lobby]),
            }],
        },
    );
    check(
        "ProtectRequest",
        &ProtectRequest {
            value: "Ann".into(),
            kind: Some("NAME".into()),
            private: Some(true),
        },
    );
    check(
        "PrivateValuesResponse",
        &PrivateValuesResponse {
            values: vec![PrivateValue {
                placeholder: "⟦PRIVATE1⟧".into(),
                kind: "PRIVATE".into(),
                value: "Storgata 5".into(),
            }],
        },
    );
    check(
        "ProtectResponse",
        &ProtectResponse {
            placeholder: "⟦NAME1⟧".into(),
        },
    );
    check(
        "CreatePlayerRequest",
        &CreatePlayerRequest {
            display_name: "Bo".into(),
        },
    );
    check("PlayerResponse", &PlayerResponse { player: ann() });
    check(
        "PairingCodeRequest",
        &PairingCodeRequest {
            player_id: "bo".into(),
        },
    );
    check(
        "PairingCodeResponse",
        &PairingCodeResponse {
            code: "7K3Q-M9XD".into(),
            link: "nudge://pair".into(),
            expires_at: 1.0,
        },
    );
    check(
        "RoomsResponse",
        &RoomsResponse {
            rooms: vec![room()],
        },
    );
    check(
        "TokensResponse",
        &TokensResponse {
            tokens: vec![TokenInfo {
                client_id: "c".into(),
                player_id: "ann".into(),
                created_at: 1.0,
                client: Some(client),
            }],
        },
    );
    for (platform, environment) in [
        (DevicePlatform::Apns, Some(PushEnvironment::Sandbox)),
        (DevicePlatform::Apns, Some(PushEnvironment::Production)),
    ] {
        check(
            "DeviceRequest",
            &DeviceRequest {
                platform,
                token: "ab12".into(),
                environment,
            },
        );
    }
    check(
        "DeviceRequest",
        &DeviceRequest {
            platform: DevicePlatform::Fcm,
            token: "x".into(),
            environment: Some(PushEnvironment::Production),
        },
    );
    check(
        "DevicesResponse",
        &DevicesResponse {
            apns: true,
            fcm: false,
        },
    );
    let roles = [
        ModelRole::System,
        ModelRole::User,
        ModelRole::Assistant,
        ModelRole::ToolResult,
    ];
    check(
        "ModelViewResponse",
        &ModelViewResponse {
            messages: roles
                .into_iter()
                .map(|role| ModelMessage {
                    role,
                    text: "⟦NAME1⟧".into(),
                })
                .collect(),
        },
    );
    let month = MonthUsage {
        month: "2026-10".into(),
        total: 1.5,
        players: [("ann".to_owned(), 1.0)].into(),
        rooms: [("trip".to_owned(), 1.5)].into(),
    };
    check("MonthUsage", &month);
    check(
        "UsageResponse",
        &UsageResponse {
            month: "2026-10".into(),
            total: 1.5,
            mine: 1.0,
            budget: UsageBudget {
                monthly_usd: Some(20.0),
                per_player_usd: Some(5.0),
            },
            months: Some(vec![month]),
        },
    );
}

#[test]
fn reads_what_it_does_not_know() {
    // New keys are ignored; new kinds of part, item, status and frame read as `Unknown`.
    let item: TimelineItem =
        serde_json::from_value(json!({ "type": "poll", "id": "p:1" })).unwrap();
    assert_eq!(item, TimelineItem::Unknown);
    let part: Part = serde_json::from_value(json!({ "type": "image", "url": "x" })).unwrap();
    assert_eq!(part, Part::Unknown);
    let status: Status = serde_json::from_value(json!({ "kind": "thinking" })).unwrap();
    assert_eq!(status, Status::Unknown);
    let frame: ServerFrame =
        serde_json::from_value(json!({ "type": "resume", "from": 3 })).unwrap();
    assert_eq!(frame, ServerFrame::Unknown);
    let player: Player =
        serde_json::from_value(json!({ "id": "a", "displayName": "A", "avatar": "x" })).unwrap();
    assert_eq!(player, ann_like("a", "A"));
    assert_eq!(Target::parse("room:"), None);
    assert_eq!(Target::parse("rooms"), None);
    assert_eq!(Target::parse("room:a:b"), Some(Target::Room("a:b".into())));
}

fn ann_like(id: &str, name: &str) -> Player {
    Player {
        id: id.into(),
        display_name: name.into(),
    }
}
