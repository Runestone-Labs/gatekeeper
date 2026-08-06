import SwiftUI

@main
struct GatekeeperBarApp: App {
    @StateObject private var state = AppState()

    init() {
        NotificationManager.shared.setup()
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContentView(state: state)
        } label: {
            // The badge IS the product: a pull surface that can't fail silently.
            if state.pending.isEmpty {
                Image(systemName: "shield.lefthalf.filled")
            } else {
                Image(systemName: "shield.lefthalf.filled.badge.checkmark")
                Text("\(state.pending.count)")
            }
        }
        .menuBarExtraStyle(.window)
    }
}
