/** Shared seed IDs and helpers. Imported by every domain seed file. */

export const ids = {
  tenant: "tenant_demo",
  // Users
  admin:       "user_admin_demo",
  manager:     "user_manager_demo",
  supervisor:  "user_supervisor_demo",
  rep:         "user_rep_demo",
  rep2:        "user_rep2_demo",
  rep3:        "user_rep3_demo",
  // Team
  team: "team_demo",
  // Payment Terms
  termCOD:   "term_cod_demo",
  termNET15: "term_net15_demo",
  termNET30: "term_net30_demo",
  termNET60: "term_net60_demo",
  // Customers
  custAcme:     "cust_acme_demo",
  custSiamTech: "cust_siamtech_demo",
  custBKKFood:  "cust_bkkfood_demo",
  custThaiSteel:"cust_thaisteel_demo",
  custPremier:  "cust_premier_demo",
  custEastAsia: "cust_eastasia_demo",
  custGolden:   "cust_golden_demo",
  custRajaPlas: "cust_rajaplas_demo",
  custCentral:  "cust_central_demo",
  custNorth:    "cust_north_demo",
  custSunrise:  "cust_sunrise_demo",
  custMega:     "cust_mega_demo",
  custViva:     "cust_viva_demo",
  custAmarin:   "cust_amarin_demo",
  custOmega:    "cust_omega_demo",
  // Items
  itemA:  "item_a_demo",
  itemB:  "item_b_demo",
  itemC:  "item_c_demo",
  itemD:  "item_d_demo",
  itemE:  "item_e_demo",
  itemF:  "item_f_demo",
  itemG:  "item_g_demo",
  // Deal Stages
  stageOpportunity: "stage_opp_demo",
  stageQuotation:   "stage_quot_demo",
  stageNegotiation: "stage_neg_demo",
  stageWon:         "stage_won_demo",
  stageLost:        "stage_lost_demo",
  // Deals (25 + 10 test deals)
  deal01: "deal_001_demo", deal02: "deal_002_demo", deal03: "deal_003_demo",
  deal04: "deal_004_demo", deal05: "deal_005_demo", deal06: "deal_006_demo",
  deal07: "deal_007_demo", deal08: "deal_008_demo", deal09: "deal_009_demo",
  deal10: "deal_010_demo", deal11: "deal_011_demo", deal12: "deal_012_demo",
  deal13: "deal_013_demo", deal14: "deal_014_demo", deal15: "deal_015_demo",
  deal16: "deal_016_demo", deal17: "deal_017_demo", deal18: "deal_018_demo",
  deal19: "deal_019_demo", deal20: "deal_020_demo", deal21: "deal_021_demo",
  deal22: "deal_022_demo", deal23: "deal_023_demo", deal24: "deal_024_demo",
  deal25: "deal_025_demo",
  deal26: "deal_026_demo", deal27: "deal_027_demo", deal28: "deal_028_demo",
  deal29: "deal_029_demo", deal30: "deal_030_demo", deal31: "deal_031_demo",
  deal32: "deal_032_demo", deal33: "deal_033_demo", deal34: "deal_034_demo",
  deal35: "deal_035_demo",
  // Visits
  visit01: "visit_01_demo", visit02: "visit_02_demo", visit03: "visit_03_demo",
  visit04: "visit_04_demo", visit05: "visit_05_demo", visit06: "visit_06_demo",
  visit07: "visit_07_demo", visit08: "visit_08_demo",
  visit09: "visit_09_demo", visit10: "visit_10_demo", visit11: "visit_11_demo",
  visit12: "visit_12_demo", visit13: "visit_13_demo", visit14: "visit_14_demo",
  visit15: "visit_15_demo", visit16: "visit_16_demo",
  visit17: "visit_17_demo", visit18: "visit_18_demo", visit19: "visit_19_demo",
  visit20: "visit_20_demo", visit21: "visit_21_demo", visit22: "visit_22_demo",
  visit23: "visit_23_demo", visit24: "visit_24_demo", visit25: "visit_25_demo",
  visit26: "visit_26_demo",
  // Integration
  source: "source_rest_demo"
};

export function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 86_400_000);
}
