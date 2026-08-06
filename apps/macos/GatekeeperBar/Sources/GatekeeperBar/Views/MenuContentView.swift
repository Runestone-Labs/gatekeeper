import SwiftUI

struct MenuContentView: View {
    @ObservedObject var state: AppState
    @State private var showSettings = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if showSettings || !state.configured {
                SettingsView(state: state, dismiss: { showSettings = false })
            } else {
                todayPanel
                Divider()
                approvalsList
            }
            Divider()
            footer
        }
        .frame(width: 340)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(state.serverUp ? Color.green : Color.red)
                .frame(width: 9, height: 9)
            Text("Gatekeeper")
                .font(.headline)
            Spacer()
            if let err = state.lastError {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.yellow)
                    .help(err)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var todayPanel: some View {
        HStack(spacing: 16) {
            stat("Calls", "\(state.today.calls)")
            stat("Denies", "\(state.today.denies)")
            stat("Spend", String(format: "$%.2f", state.today.spendUsd))
            if let remaining = state.today.budgetRemainingUsd {
                stat(
                    "Budget left",
                    String(format: "$%.2f", max(remaining, 0)),
                    warn: state.today.budgetExceeded
                )
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func stat(_ label: String, _ value: String, warn: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(.callout, design: .monospaced).weight(.medium))
                .foregroundStyle(warn ? .red : .primary)
        }
    }

    private var approvalsList: some View {
        Group {
            if state.pending.isEmpty {
                VStack(spacing: 4) {
                    Image(systemName: "checkmark.shield")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text("No pending approvals")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(state.pending) { hold in
                            ApprovalRowView(hold: hold) { approve in
                                Task { await state.decide(holdId: hold.id, approve: approve) }
                            }
                            if hold.id != state.pending.last?.id { Divider() }
                        }
                    }
                }
                .frame(maxHeight: 320)
            }
        }
    }

    private var footer: some View {
        HStack {
            Button(showSettings ? "Back" : "Settings") {
                showSettings.toggle()
            }
            .buttonStyle(.plain)
            .font(.caption)
            .foregroundStyle(.secondary)
            Spacer()
            Button("Quit") { NSApp.terminate(nil) }
                .buttonStyle(.plain)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

struct ApprovalRowView: View {
    let hold: PendingHold
    let onDecision: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(hold.toolName)
                    .font(.system(.callout, design: .monospaced).weight(.semibold))
                if hold.external {
                    Text("external")
                        .font(.caption2)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.blue.opacity(0.15)))
                }
                Spacer()
                Text("expires \(hold.expiresAtDate, style: .relative)")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }

            Text("agent: \(hold.actor.name)")
                .font(.caption)
                .foregroundStyle(.secondary)

            Text(hold.argsSummary)
                .font(.system(.caption, design: .monospaced))
                .lineLimit(4)
                .textSelection(.enabled)
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 5).fill(.quaternary.opacity(0.5)))

            HStack(spacing: 8) {
                Button {
                    onDecision(true)
                } label: {
                    Label("Approve", systemImage: "checkmark")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
                .controlSize(.small)

                Button {
                    onDecision(false)
                } label: {
                    Label("Deny", systemImage: "xmark")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .controlSize(.small)
            }
        }
        .padding(12)
    }
}

struct SettingsView: View {
    @ObservedObject var state: AppState
    var dismiss: () -> Void

    @State private var url: String = ""
    @State private var secret: String = ""
    @State private var testResult: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Connection")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("http://127.0.0.1:3847", text: $url)
                .textFieldStyle(.roundedBorder)
            SecureField("Gatekeeper secret", text: $secret)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button("Save & Test") {
                    state.baseURLString = url
                    state.updateSecret(secret)
                    Task {
                        await state.refreshPending()
                        testResult = state.serverUp
                            ? (state.lastError == nil ? "Connected ✓" : "Server up, auth failed")
                            : "Unreachable"
                        if state.serverUp && state.lastError == nil { dismiss() }
                    }
                }
                .controlSize(.small)
                if let testResult {
                    Text(testResult)
                        .font(.caption)
                        .foregroundStyle(testResult.contains("✓") ? .green : .red)
                }
            }
        }
        .padding(12)
        .onAppear {
            url = state.baseURLString
            secret = state.secretForEditing
        }
    }
}
