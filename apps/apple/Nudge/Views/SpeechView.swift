import Nudge
import SwiftUI

/// Dictation's speech model, downloaded to this device, and the languages the player speaks.
struct SpeechView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var speech = model.speech
        Form {
            Section {
                ForEach(speech.models, id: \.id) { candidate in
                    ModelRow(speech: speech, candidate: candidate)
                }
            } header: {
                Text("Speech model")
            } footer: {
                Text("What you say is written out on this device: your voice never leaves it. Nudge hides personal details from the assistant's model in the text, as in what you type.")
            }
            Section {
                ForEach(speech.languages, id: \.self) { tag in
                    LabeledContent(Speech.name(of: tag)) {
                        if !speaks(tag) { Text("Not with this model").foregroundStyle(.secondary) }
                    }
                }
                .onDelete { offsets in
                    // At least one.
                    guard speech.languages.count > offsets.count else { return }
                    speech.languages.remove(atOffsets: offsets)
                }
                .onMove { speech.languages.move(fromOffsets: $0, toOffset: $1) }
                Menu("Add a language") {
                    let more = (Speech.common + Speech.deviceLanguages())
                        .filter { tag in !speech.languages.contains { Speech.language(of: $0) == Speech.language(of: tag) } }
                    ForEach(Array(Set(more)).sorted { Speech.name(of: $0) < Speech.name(of: $1) }, id: \.self) { tag in
                        Button(Speech.name(of: tag)) { speech.languages.append(tag) }
                    }
                }
            } header: {
                Text("Languages you speak")
            } footer: {
                Text("Dictation hears which of these you speak, and can switch between them from one sentence to the next.")
            }
            if let problem = speech.problem {
                Section { Text(problem).foregroundStyle(.red) }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Speech")
        #if os(iOS)
        .toolbar { EditButton() }
        #endif
        .onAppear { speech.refresh() }
    }

    private func speaks(_ tag: String) -> Bool {
        guard let languages = model.speech.model?.languages, !languages.isEmpty else { return true }
        let language = Speech.language(of: tag)
        return languages.contains(language == "nb" ? "no" : language)
    }
}

private struct ModelRow: View {
    let speech: Speech
    let candidate: SpeechModel

    var body: some View {
        let chosen = speech.modelId == candidate.id
        HStack {
            Button {
                speech.modelId = candidate.id
            } label: {
                HStack {
                    Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(chosen ? Color.accentColor : .secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(candidate.name)
                        Text("\(candidate.description) · \(megabytes(candidate.bytes))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            Spacer()
            if let progress = speech.downloading[candidate.id] {
                ProgressView(value: progress).progressViewStyle(.circular).controlSize(.small)
            } else if speech.downloaded.contains(candidate.id) {
                Text("On this device").font(.caption).foregroundStyle(.secondary)
            } else {
                Button("Download") { Task { await speech.download(candidate.id) } }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .swipeActions {
            if speech.downloaded.contains(candidate.id) {
                Button("Remove", role: .destructive) { speech.remove(candidate.id) }
            }
        }
    }
}
