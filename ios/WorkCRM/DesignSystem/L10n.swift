import Foundation

/// Bilingual string lookup (Thai + English). Workselected.com treats both
/// languages as first-class — we mirror that here. The app auto-picks based on
/// `Locale.current` but the user can override in Settings (future work).
///
/// New strings get added by enum case + a `(th, en)` tuple in `Self.dictionary`.
/// This keeps translations colocated in one file rather than scattered across
/// the codebase's many xliff/Localizable.strings flavors.
public enum L10n: String {
    case loginTitle
    case loginTenantSlug
    case loginEmail
    case loginPassword
    case loginCta
    case loginError

    case tabToday
    case tabDeals
    case tabKpi
    case tabMore

    case dealsScopeAll
    case dealsScopeMine
    case dealsScopeTeam
    case dealsSearchPlaceholder
    case dealsShowClosed
    case dealsOverdueLabel

    case visitsTitle
    case visitsEmpty
    case visitCheckIn
    case visitCheckOut
    case visitPendingSync
    case visitOffline

    case kpiPersonalTitle
    case kpiTeamTitle
    case kpiVisits
    case kpiWonDeals
    case kpiRevenue
    case kpiConversion
    case kpiDaysLeft

    case commonRetry
    case commonCancel
    case commonOk
    case commonLoading

    public var localized: String {
        let useThai = Locale.current.language.languageCode?.identifier == "th"
        let pair = Self.dictionary[self] ?? ("", "")
        return useThai ? pair.th : pair.en
    }

    private static let dictionary: [L10n: (th: String, en: String)] = [
        .loginTitle:        ("เข้าสู่ระบบ",            "Sign in"),
        .loginTenantSlug:   ("รหัสองค์กร",             "Workspace slug"),
        .loginEmail:        ("อีเมล",                  "Email"),
        .loginPassword:     ("รหัสผ่าน",                "Password"),
        .loginCta:          ("เข้าสู่ระบบ",            "Sign in"),
        .loginError:        ("ลงชื่อเข้าใช้ล้มเหลว",    "Sign-in failed"),

        .tabToday:          ("วันนี้",                 "Today"),
        .tabDeals:          ("ดีล",                    "Deals"),
        .tabKpi:            ("เป้า KPI",               "KPI"),
        .tabMore:           ("เพิ่มเติม",               "More"),

        .dealsScopeAll:         ("ทั้งหมด",               "All"),
        .dealsScopeMine:        ("ของฉัน",                "Me"),
        .dealsScopeTeam:        ("ทีมของฉัน",             "My team"),
        .dealsSearchPlaceholder:("ค้นหาดีล",              "Search deals"),
        .dealsShowClosed:       ("รวมที่ปิดแล้ว",         "Show closed"),
        .dealsOverdueLabel:     ("ต้องติดตาม",            "Needs follow-up"),

        .visitsTitle:       ("รายการเยี่ยมวันนี้",      "Today's visits"),
        .visitsEmpty:       ("ไม่มีนัดในวันนี้",         "No visits scheduled"),
        .visitCheckIn:      ("เช็คอิน",                "Check in"),
        .visitCheckOut:     ("เช็คเอาท์",              "Check out"),
        .visitPendingSync:  ("รอซิงค์",                 "Pending sync"),
        .visitOffline:      ("ออฟไลน์",                 "Offline"),

        .kpiPersonalTitle:  ("เป้าหมายของฉัน",         "My KPI"),
        .kpiTeamTitle:      ("เป้าหมายทีม",            "Team KPI"),
        .kpiVisits:         ("จำนวนเยี่ยม",             "Visits"),
        .kpiWonDeals:       ("ดีลที่ปิดได้",            "Won deals"),
        .kpiRevenue:        ("ยอดขาย",                 "Revenue"),
        .kpiConversion:     ("อัตราปิดดีล",            "Conversion"),
        .kpiDaysLeft:       ("วันที่เหลือ",             "Days left"),

        .commonRetry:       ("ลองอีกครั้ง",             "Retry"),
        .commonCancel:      ("ยกเลิก",                 "Cancel"),
        .commonOk:          ("ตกลง",                   "OK"),
        .commonLoading:     ("กำลังโหลด…",             "Loading…")
    ]
}

/// Quality-of-life: `t(.loginTitle)` reads better than `L10n.loginTitle.localized`.
public func t(_ key: L10n) -> String { key.localized }
