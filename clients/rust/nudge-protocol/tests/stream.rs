//! Replays what Ann's socket received in a recorded run of room "trip" and her home
//! (`packages/protocol/test/fixtures/room-stream.jsonl`, recorded by the server's
//! `v1-stream.test.ts`): every frame reads as a `ServerFrame` and validates against the schema,
//! and applying the patches rebuilds every recorded view, which reads as a typed view.

use std::collections::BTreeMap;

use nudge_protocol::*;
use serde_json::Value;

fn fixture(name: &str) -> String {
    let path = format!(
        "{}/../../../packages/protocol/test/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(path).unwrap()
}

fn schema(name: &str) -> jsonschema::Validator {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/schema/v1.json"
    );
    let document: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    jsonschema::validator_for(&document["$defs"][name]).unwrap()
}

#[test]
fn patches_rebuild_every_recorded_view() {
    let frames = schema("ServerFrame");
    let mut views: BTreeMap<Target, Value> = BTreeMap::new();
    let mut seqs: BTreeMap<Target, u64> = BTreeMap::new();
    let mut patches = 0;
    let text = fixture("room-stream.jsonl");
    let lines: Vec<Value> = text
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    for (number, line) in lines.iter().enumerate() {
        let raw = &line["frame"];
        assert!(frames.is_valid(raw), "line {number}: not a ServerFrame");
        let frame: ServerFrame = serde_json::from_value(raw.clone()).unwrap();
        // What reads as a frame writes back as the same JSON.
        assert_eq!(
            numbers(serde_json::to_value(&frame).unwrap()),
            numbers(raw.clone()),
            "line {number}"
        );
        let target = match frame {
            ServerFrame::Welcome(welcome) => {
                assert_eq!(number, 0);
                assert_eq!(welcome.protocol, PROTOCOL_VERSION);
                continue;
            }
            ServerFrame::Snapshot { target, seq, view } => {
                assert_eq!(seq, 0);
                seqs.insert(target.clone(), 0);
                views.insert(target.clone(), view);
                target
            }
            ServerFrame::Patch { target, seq, ops } => {
                assert_eq!(seq, seqs[&target] + 1, "line {number}: seq");
                seqs.insert(target.clone(), seq);
                apply_in_place(views.get_mut(&target).unwrap(), &ops).unwrap();
                patches += 1;
                target
            }
            other => panic!("line {number}: unexpected {other:?}"),
        };
        let view = &views[&target];
        assert_eq!(view, &line["view"], "line {number}: view");
        // The typed view writes back as the same JSON, so no field is lost on the way.
        let typed = match target {
            Target::Home => {
                serde_json::to_value(serde_json::from_value::<HomeView>(view.clone()).unwrap())
            }
            Target::Room(_) => {
                serde_json::to_value(serde_json::from_value::<RoomView>(view.clone()).unwrap())
            }
        };
        assert_eq!(
            numbers(typed.unwrap()),
            numbers(view.clone()),
            "line {number}: typed view"
        );
    }
    assert_eq!(
        seqs.keys().map(ToString::to_string).collect::<Vec<_>>(),
        ["home", "room:trip"]
    );
    assert!(patches > 3, "the recording has patches");
}

/// `value` with every number as a float, since a timestamp read as `f64` writes back as `1.0`.
fn numbers(value: Value) -> Value {
    match value {
        Value::Number(number) => serde_json::json!(number.as_f64().unwrap()),
        Value::Array(items) => Value::Array(items.into_iter().map(numbers).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, numbers(value)))
                .collect(),
        ),
        other => other,
    }
}
