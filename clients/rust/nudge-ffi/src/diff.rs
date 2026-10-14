/// One change to a list, after the ones before it, like eyeball-im's `VectorDiff`: a UI applies
/// them in order instead of taking the whole list again, so a streamed answer costs one `Set`.
#[derive(Clone, Debug, PartialEq)]
pub enum Change<T> {
    Reset { values: Vec<T> },
    Append { values: Vec<T> },
    Insert { index: u32, value: T },
    Set { index: u32, value: T },
    Remove { index: u32 },
}

/// The changes that turn `old` into `new`. Items are matched by `id`: the same id at the same
/// place is a `Set` when the item changed. What lies between the common head and tail is
/// removed and inserted, or the whole list reset when that would be more than the list itself.
pub fn changes<T: PartialEq + Clone>(
    old: &[T],
    new: &[T],
    id: impl Fn(&T) -> &str,
) -> Vec<Change<T>> {
    if old.is_empty() {
        return if new.is_empty() {
            vec![]
        } else {
            vec![Change::Reset {
                values: new.to_vec(),
            }]
        };
    }
    let head = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    let tail = old[head..]
        .iter()
        .rev()
        .zip(new[head..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let old_middle = &old[head..old.len() - tail];
    let new_middle = &new[head..new.len() - tail];
    if old_middle.len() == new_middle.len()
        && old_middle
            .iter()
            .zip(new_middle)
            .all(|(a, b)| id(a) == id(b))
    {
        return old_middle
            .iter()
            .zip(new_middle)
            .enumerate()
            .filter(|(_, (a, b))| a != b)
            .map(|(offset, (_, b))| Change::Set {
                index: (head + offset) as u32,
                value: b.clone(),
            })
            .collect();
    }
    if old_middle.is_empty() && tail == 0 {
        return vec![Change::Append {
            values: new_middle.to_vec(),
        }];
    }
    if old_middle.len() + new_middle.len() > new.len() {
        return vec![Change::Reset {
            values: new.to_vec(),
        }];
    }
    let removes = old_middle
        .iter()
        .map(|_| Change::Remove { index: head as u32 });
    let inserts = new_middle
        .iter()
        .enumerate()
        .map(|(offset, value)| Change::Insert {
            index: (head + offset) as u32,
            value: value.clone(),
        });
    removes.chain(inserts).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    struct Item(String, String);

    fn items(spec: &str) -> Vec<Item> {
        // "a b2 c": id a, id b with text 2, …
        spec.split_whitespace()
            .map(|word| Item(word[..1].into(), word[1..].into()))
            .collect()
    }

    fn apply(mut list: Vec<Item>, changes: &[Change<Item>]) -> Vec<Item> {
        for change in changes {
            match change.clone() {
                Change::Reset { values } => list = values,
                Change::Append { values } => list.extend(values),
                Change::Insert { index, value } => list.insert(index as usize, value),
                Change::Set { index, value } => list[index as usize] = value,
                Change::Remove { index } => {
                    list.remove(index as usize);
                }
            }
        }
        list
    }

    fn diff(old: &str, new: &str) -> Vec<Change<Item>> {
        let (old, new) = (items(old), items(new));
        let changes = changes(&old, &new, |item| &item.0);
        assert_eq!(
            apply(old, &changes),
            new,
            "the changes rebuild the new list"
        );
        changes
    }

    #[test]
    fn streams_as_sets_and_grows_as_appends() {
        assert_eq!(
            diff("a b c1", "a b c12"),
            vec![Change::Set {
                index: 2,
                value: Item("c".into(), "12".into())
            }]
        );
        assert_eq!(
            diff("a b", "a b c d"),
            vec![Change::Append {
                values: items("c d")
            }]
        );
        assert_eq!(diff("a b", "a b"), vec![]);
        assert_eq!(diff("", ""), vec![]);
        assert_eq!(diff("", "a"), vec![Change::Reset { values: items("a") }]);
    }

    #[test]
    fn removes_and_inserts_in_the_middle_or_resets() {
        assert_eq!(diff("a b c", "b c"), vec![Change::Remove { index: 0 }]);
        assert_eq!(
            diff("a b c d", "z a b c"),
            vec![Change::Reset {
                values: items("z a b c")
            }]
        );
        assert_eq!(
            diff("a b c d e", "a x d e"),
            vec![
                Change::Remove { index: 1 },
                Change::Remove { index: 1 },
                Change::Insert {
                    index: 1,
                    value: Item("x".into(), "".into())
                }
            ]
        );
        assert_eq!(
            diff("a b", "c d"),
            vec![Change::Reset {
                values: items("c d")
            }]
        );
        diff("a b c", "");
        diff("a1 b1 c1", "a2 b1 c2");
    }
}
