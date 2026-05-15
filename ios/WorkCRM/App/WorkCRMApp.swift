import SwiftUI

@main
struct WorkCRMApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var auth = AuthViewModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(auth)
                .preferredColorScheme(.dark)
        }
    }
}

/// Top-level router: if there's a stored session, show the biometric gate then
/// the main tab UI. If not, show LoginView. Reacts live to sign-in / sign-out
/// via the published `session` on `AuthViewModel`.
struct RootView: View {
    @EnvironmentObject private var auth: AuthViewModel

    var body: some View {
        Group {
            if auth.isSignedIn {
                BiometricGate { MainTabView() }
            } else {
                LoginView()
            }
        }
        // Tint applies to navigation chrome and progress rings throughout
        // the tab stack — anchors the gold accent of the design system.
        .tint(Theme.Color.accent)
    }
}

/// Bottom tabs. Today (visits) is the smoke-test target; the others are
/// stubbed and tracked in follow-up work.
struct MainTabView: View {
    var body: some View {
        TabView {
            NavigationStack {
                VisitListView()
                    .navigationTitle(t(.tabToday))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbarBackground(Theme.Color.backgroundPrimary, for: .navigationBar)
                    .toolbarColorScheme(.dark, for: .navigationBar)
            }
            .tabItem { Label(t(.tabToday), systemImage: "calendar.day.timeline.left") }

            NavigationStack {
                DealKanbanView()
                    .navigationTitle(t(.tabDeals))
            }
            .tabItem { Label(t(.tabDeals), systemImage: "rectangle.split.3x1") }

            NavigationStack {
                PersonalKpiView()
                    .navigationTitle(t(.tabKpi))
            }
            .tabItem { Label(t(.tabKpi), systemImage: "target") }

            NavigationStack {
                MoreView()
                    .navigationTitle(t(.tabMore))
            }
            .tabItem { Label(t(.tabMore), systemImage: "ellipsis.circle") }
        }
        .background(Theme.Color.backgroundPrimary.ignoresSafeArea())
    }
}

private struct MoreView: View {
    @EnvironmentObject private var auth: AuthViewModel
    var body: some View {
        List {
            if let user = auth.session?.user {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(user.fullName).font(Theme.Font.title())
                        Text(user.email).font(Theme.Font.caption()).foregroundStyle(.secondary)
                    }
                }
            }
            NavigationLink("Customers")    { CustomerListView() }
            NavigationLink("Items")        { ItemListView() }
            NavigationLink("Team KPI")     { TeamKpiView() }
            NavigationLink("Sync Status")  { SyncStatusView() }
            Section {
                Button("Sign out", role: .destructive) { auth.signOut() }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.Color.backgroundPrimary)
    }
}
