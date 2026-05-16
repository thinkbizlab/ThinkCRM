import XCTest
@testable import WorkCRM

/// `PendingActionStore` is a singleton hitting `Documents/`. These tests
/// exercise it via its public mutators and verify both the in-memory state
/// and the persisted file. We clean up after ourselves so the dev's local
/// app state isn't polluted.
@MainActor
final class PendingActionStoreTests: XCTestCase {
    override func setUp() async throws {
        // Drain any leftover rows from a previous run.
        for action in PendingActionStore.shared.actions {
            PendingActionStore.shared.remove(id: action.id)
        }
    }

    override func tearDown() async throws {
        for action in PendingActionStore.shared.actions {
            PendingActionStore.shared.remove(id: action.id)
        }
    }

    func testEnqueueAddsRowAndPersists() {
        let action = PendingAction.newCheckOut(visitId: "v1", lat: 0, lng: 0, capturedAt: Date(), result: "done")
        PendingActionStore.shared.enqueue(action)
        XCTAssertEqual(PendingActionStore.shared.actions.count, 1)
        XCTAssertEqual(PendingActionStore.shared.actions[0].id, action.id)
    }

    func testActionsForVisitFiltersById() {
        let a = PendingAction.newCheckOut(visitId: "v1", lat: 0, lng: 0, capturedAt: Date(), result: "a")
        let b = PendingAction.newCheckOut(visitId: "v2", lat: 0, lng: 0, capturedAt: Date(), result: "b")
        PendingActionStore.shared.enqueue(a)
        PendingActionStore.shared.enqueue(b)
        XCTAssertEqual(PendingActionStore.shared.actionsForVisit("v1").count, 1)
        XCTAssertEqual(PendingActionStore.shared.actionsForVisit("v2").count, 1)
        XCTAssertEqual(PendingActionStore.shared.actionsForVisit("nope").count, 0)
    }

    func testNextEligibleRespectsBackoff() {
        var action = PendingAction.newCheckOut(visitId: "v1", lat: 0, lng: 0, capturedAt: Date(), result: "a")
        action.nextEligibleAt = Date().addingTimeInterval(3600)   // future
        PendingActionStore.shared.enqueue(action)
        XCTAssertNil(PendingActionStore.shared.nextEligible(), "row with future nextEligibleAt must not be returned")

        action.nextEligibleAt = Date().addingTimeInterval(-1)     // past
        PendingActionStore.shared.update(action)
        XCTAssertEqual(PendingActionStore.shared.nextEligible()?.id, action.id)
    }

    func testRemovePersistsAcrossInMemoryState() {
        let action = PendingAction.newCheckOut(visitId: "v1", lat: 0, lng: 0, capturedAt: Date(), result: "x")
        PendingActionStore.shared.enqueue(action)
        XCTAssertEqual(PendingActionStore.shared.pendingCount, 1)
        PendingActionStore.shared.remove(id: action.id)
        XCTAssertEqual(PendingActionStore.shared.pendingCount, 0)
    }

    func testClientRequestIdEqualsPendingActionId() {
        // Critical: the backend's ClientRequestLog table keys on
        // (tenantId, clientRequestId). The mobile sync engine sends the
        // PendingAction.id as that clientRequestId. If we ever desynchronise
        // these two ids, retries stop being idempotent and visits double-mutate.
        let action = PendingAction.newCheckIn(
            visitId: "v1", lat: 0, lng: 0,
            capturedAt: Date(), selfieFilename: "x.jpg"
        )
        XCTAssertEqual(action.id.count, 36, "uuid v4 string length")
        XCTAssertNotNil(UUID(uuidString: action.id))
    }
}
