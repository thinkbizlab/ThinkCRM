import Foundation
import BackgroundTasks

/// Registers a BGAppRefreshTask so iOS wakes us periodically to drain the
/// pending-action queue without the user reopening the app. This is what
/// makes "rep checks in offline, locks phone, drives back" actually work —
/// otherwise the visit only syncs when they return to the foreground.
public enum BackgroundSync {
    public static let taskIdentifier = "com.workstationoffice.workcrm.sync"

    /// Call from `AppDelegate.application(_:didFinishLaunchingWithOptions:)`.
    public static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: nil) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(task: refreshTask)
        }
    }

    /// Ask the OS to wake us in ~15 min. The system may grant more or less
    /// based on signal/battery/usage — that's fine, we just want to opt in.
    public static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // BGTaskScheduler errors out in the simulator and when the user
            // has explicitly disabled background refresh — both are fine.
            print("[bg] schedule failed: \(error)")
        }
    }

    private static func handle(task: BGAppRefreshTask) {
        // Reschedule first so the next window is always queued, even if we
        // crash or time out mid-drain.
        schedule()

        let drainTask = Task {
            await SyncEngine.shared.drain()
        }

        task.expirationHandler = {
            drainTask.cancel()
        }

        Task {
            _ = await drainTask.value
            task.setTaskCompleted(success: true)
        }
    }
}
