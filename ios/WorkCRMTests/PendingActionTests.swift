import XCTest
@testable import WorkCRM

final class PendingActionTests: XCTestCase {
    func testCheckInPayloadRoundTripsThroughJSON() throws {
        let original = PendingAction.newCheckIn(
            visitId:        "visit-123",
            lat:            13.7563,
            lng:            100.5018,
            capturedAt:     Date(timeIntervalSince1970: 1_710_000_000),
            selfieFilename: "abc.jpg"
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode([original])

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let roundTripped = try decoder.decode([PendingAction].self, from: data)

        XCTAssertEqual(roundTripped.count, 1)
        XCTAssertEqual(roundTripped[0].id, original.id)
        XCTAssertEqual(roundTripped[0].visitId, "visit-123")
        XCTAssertEqual(roundTripped[0].kind, .visitCheckIn)
        if case .checkIn(let p) = roundTripped[0].payload {
            XCTAssertEqual(p.lat, 13.7563, accuracy: 0.0001)
            XCTAssertEqual(p.lng, 100.5018, accuracy: 0.0001)
            XCTAssertEqual(p.selfieFilename, "abc.jpg")
        } else {
            XCTFail("Expected check-in payload")
        }
    }

    func testCheckOutPayloadRoundTripsThroughJSON() throws {
        let original = PendingAction.newCheckOut(
            visitId:    "visit-456",
            lat:        14.0,
            lng:        100.0,
            capturedAt: Date(),
            result:     "ลูกค้าตอบรับ"
        )
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(PendingAction.self, from: data)
        XCTAssertEqual(decoded.kind, .visitCheckOut)
        if case .checkOut(let p) = decoded.payload {
            XCTAssertEqual(p.result, "ลูกค้าตอบรับ")
        } else {
            XCTFail("Expected check-out payload")
        }
    }

    func testPendingActionIdIsValidUUID() {
        let action = PendingAction.newCheckOut(visitId: "v", lat: 0, lng: 0, capturedAt: Date(), result: "ok")
        XCTAssertNotNil(UUID(uuidString: action.id), "id must be a valid UUID — backend's ClientRequestLog assumes uuid v4")
    }
}
