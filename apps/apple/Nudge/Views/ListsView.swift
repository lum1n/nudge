import Nudge
import SwiftUI

/// The room's shared lists, such as shopping and to-dos; the assistant edits them too.
struct ListsView: View {
    @Environment(\.dismiss) private var dismiss
    let client: NudgeClient
    let roomId: String
    @State private var lists: ObservedLists?
    @State private var openingError: String?
    @State private var drafts: [String: String] = [:]
    @State private var newList = ""

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Lists")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
        }
        .onAppear {
            guard lists == nil else { return }
            do {
                lists = try client.observeLists(roomId)
            } catch {
                openingError = explain(error)
            }
        }
        .onDisappear {
            lists?.close()
            lists = nil
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 480)
        #endif
    }

    @ViewBuilder private var content: some View {
        let state = lists?.value
        if let openingError {
            ContentUnavailableView("Can't open the lists", systemImage: "exclamationmark.triangle", description: Text(openingError))
        } else if case .closed(let code, _)? = state?.status, code == 4404 {
            ContentUnavailableView(
                "No lists here", systemImage: "checklist",
                description: Text("Turn on the lists extension for this room under Room."))
        } else if let all = state?.lists {
            Form {
                if let error = state?.error {
                    Text(error).foregroundStyle(.red)
                }
                ForEach(all) { list in
                    Section {
                        ForEach(list.items) { item in
                            ItemRow(item: item) { lists?.toggle(item, in: list.name) }
                                .swipeActions {
                                    Button("Remove", role: .destructive) { lists?.remove(item, from: list.name) }
                                }
                                .contextMenu {
                                    Button("Remove", systemImage: "trash", role: .destructive) {
                                        lists?.remove(item, from: list.name)
                                    }
                                }
                        }
                        TextField("Add to \(list.name)…", text: draft(list.name))
                            .onSubmit { add(to: list.name) }
                    } header: {
                        HStack {
                            Text(list.name.capitalized)
                            Spacer()
                            Menu {
                                Button("Clear done") { lists?.clearDone(in: list.name) }
                                Button("Delete list", role: .destructive) { lists?.delete(list: list.name) }
                            } label: {
                                Image(systemName: "ellipsis.circle")
                            }
                            .fixedSize()
                        }
                    }
                }
                Section("New list") {
                    TextField("Name, then its first item below", text: $newList)
                    if !newList.trimmingCharacters(in: .whitespaces).isEmpty {
                        TextField("First item", text: draft(newList))
                            .onSubmit {
                                add(to: newList)
                                newList = ""
                            }
                    }
                }
            }
            .formStyle(.grouped)
        } else {
            ProgressView()
        }
    }

    private func draft(_ list: String) -> Binding<String> {
        Binding(get: { drafts[list] ?? "" }, set: { drafts[list] = $0 })
    }

    private func add(to list: String) {
        let text = (drafts[list] ?? "").trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        lists?.add(text, to: list)
        drafts[list] = nil
    }
}

private struct ItemRow: View {
    let item: ListItem
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack {
                Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(item.done ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                VStack(alignment: .leading) {
                    Text(item.text).strikethrough(item.done).foregroundStyle(item.done ? .secondary : .primary)
                    Text(item.by).font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
