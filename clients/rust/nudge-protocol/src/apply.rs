use serde_json::Value;

use crate::schema::{Op, PathKey};

/// An op that doesn't fit the view. A client then subscribes again.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ApplyError(String);

/// `view` with `ops` applied in order, as `apply` in `@nudge/protocol` does. `view` itself is left
/// alone.
pub fn apply(view: &Value, ops: &[Op]) -> Result<Value, ApplyError> {
    let mut next = view.clone();
    apply_in_place(&mut next, ops)?;
    Ok(next)
}

/// Applies `ops` to `view` in order. When one doesn't fit, the ones before it stay applied, so
/// `view` is of no use after an error: wait for a new snapshot.
pub fn apply_in_place(view: &mut Value, ops: &[Op]) -> Result<(), ApplyError> {
    for op in ops {
        apply_op(view, op)?;
    }
    Ok(())
}

fn apply_op(root: &mut Value, op: &Op) -> Result<(), ApplyError> {
    let path = match op {
        Op::Set { path, .. }
        | Op::Del { path }
        | Op::Append { path, .. }
        | Op::Splice { path, .. } => path,
    };
    let Some((last, parents)) = path.split_last() else {
        return match op {
            Op::Set { value, .. } => {
                *root = value.clone();
                Ok(())
            }
            _ => Err(ApplyError(format!("Cannot {} the whole view", name(op)))),
        };
    };
    let mut parent = root;
    for key in parents {
        parent = child(parent, key)
            .ok_or_else(|| ApplyError(format!("No object or array at {}", show(path))))?;
        if !parent.is_object() && !parent.is_array() {
            return Err(ApplyError(format!("No object or array at {}", show(path))));
        }
    }
    match op {
        Op::Set { value, .. } => match (parent, last) {
            (Value::Object(map), key) => {
                map.insert(object_key(key), value.clone());
            }
            (Value::Array(items), PathKey::Index(index)) if *index < items.len() => {
                items[*index] = value.clone();
            }
            _ => return Err(ApplyError(format!("No item at {}", show(path)))),
        },
        Op::Del { .. } => match parent {
            Value::Object(map) => {
                map.remove(&object_key(last));
            }
            _ => {
                return Err(ApplyError(format!(
                    "Cannot del an array item at {}",
                    show(path)
                )));
            }
        },
        Op::Append { text, .. } => match child(parent, last) {
            Some(Value::String(existing)) => existing.push_str(text),
            _ => {
                return Err(ApplyError(format!(
                    "No string to append to at {}",
                    show(path)
                )));
            }
        },
        Op::Splice {
            index,
            remove,
            insert,
            ..
        } => match child(parent, last) {
            Some(Value::Array(items)) if *index <= items.len() => {
                // Like `Array.prototype.splice`, removing no more than there is.
                let end = index.saturating_add(*remove).min(items.len());
                items.splice(*index..end, insert.iter().cloned());
            }
            _ => return Err(ApplyError(format!("No array to splice at {}", show(path)))),
        },
    }
    Ok(())
}

fn child<'a>(parent: &'a mut Value, key: &PathKey) -> Option<&'a mut Value> {
    match (parent, key) {
        (Value::Object(map), key) => map.get_mut(&object_key(key)),
        (Value::Array(items), PathKey::Index(index)) => items.get_mut(*index),
        _ => None,
    }
}

/// An object's key: a number names the key it reads as, as in JavaScript.
fn object_key(key: &PathKey) -> String {
    match key {
        PathKey::Key(key) => key.clone(),
        PathKey::Index(index) => index.to_string(),
    }
}

fn name(op: &Op) -> &'static str {
    match op {
        Op::Set { .. } => "set",
        Op::Del { .. } => "del",
        Op::Append { .. } => "append",
        Op::Splice { .. } => "splice",
    }
}

fn show(path: &[PathKey]) -> String {
    let keys: Vec<String> = path.iter().map(object_key).collect();
    keys.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ops(value: Value) -> Vec<Op> {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn applies_each_kind_of_op() {
        let view = json!({ "a": { "text": "Hel" }, "list": [1, 2, 3], "gone": true });
        let next = apply(
            &view,
            &ops(json!([
                { "op": "append", "path": ["a", "text"], "text": "lo" },
                { "op": "set", "path": ["a", "new"], "value": 1 },
                { "op": "set", "path": ["list", 0], "value": 9 },
                { "op": "splice", "path": ["list"], "index": 1, "remove": 5, "insert": [7, 8] },
                { "op": "del", "path": ["gone"] },
            ])),
        )
        .unwrap();
        assert_eq!(
            next,
            json!({ "a": { "text": "Hello", "new": 1 }, "list": [9, 7, 8] })
        );
        // The original is left alone.
        assert_eq!(view["a"]["text"], "Hel");
    }

    #[test]
    fn replaces_the_whole_view() {
        let next = apply(
            &json!({ "a": 1 }),
            &ops(json!([{ "op": "set", "path": [], "value": { "b": 2 } }])),
        );
        assert_eq!(next.unwrap(), json!({ "b": 2 }));
    }

    #[test]
    fn refuses_ops_that_do_not_fit() {
        let view = json!({ "text": "x", "list": [1], "n": 1 });
        for bad in [
            json!({ "op": "del", "path": [] }),
            json!({ "op": "append", "path": ["missing"], "text": "y" }),
            json!({ "op": "append", "path": ["n"], "text": "y" }),
            json!({ "op": "set", "path": ["list", 1], "value": 2 }),
            json!({ "op": "del", "path": ["list", 0] }),
            json!({ "op": "splice", "path": ["list"], "index": 2, "remove": 0, "insert": [] }),
            json!({ "op": "splice", "path": ["text"], "index": 0, "remove": 0, "insert": [] }),
            json!({ "op": "set", "path": ["missing", "deeper"], "value": 1 }),
            json!({ "op": "set", "path": ["text", "deeper"], "value": 1 }),
        ] {
            assert!(
                apply(&view, &ops(json!([bad.clone()]))).is_err(),
                "{bad} should not apply"
            );
        }
    }
}
