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

/// Top-level router. Three states:
///   - Not signed in → LoginView
///   - Signed in but onboarding incomplete → OnboardingView (asks for system
///     permissions in plain language, one at a time)
///   - Signed in and onboarded → BiometricGate + MainTabView
///
/// Onboarding completion is sticky in `UserDefaults`; a fresh install (or
/// the user signing out + back in with a different account) re-runs it.
struct RootView: View {
    @EnvironmentObject private var auth: AuthViewModel
    @State private var didCompleteOnboarding = UserDefaults.standard.bool(forKey: OnboardingView.completionKey)

    var body: some View {
        Group {
            if auth.isSignedIn {
                if didCompleteOnboarding {
                    BiometricGate { MainTabView() }
                } else {
                    OnboardingView {
                        didCompleteOnboarding = true
                    }
                }
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
