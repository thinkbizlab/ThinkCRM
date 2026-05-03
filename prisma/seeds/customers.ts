import { CustomerType, PrismaClient } from "@prisma/client";
import { ids } from "./shared.js";

export async function seedCustomers(prisma: PrismaClient) {
  const customers: Parameters<typeof prisma.customer.create>[0]["data"][] = [
    {
      id: ids.custAcme, tenantId: ids.tenant, ownerId: ids.rep,
      customerCode: "CUST-000001", name: "บริษัท เอ็น-เทค ดิจิทัล โซลูชั่นส์ จำกัด", taxId: "0105561123450",
      customerType: CustomerType.COMPANY,
      customFields: { customerTier: "Gold" },
      addresses: { create: { addressLine1: "45/12 ถนนพระราม 9", city: "กรุงเทพมหานคร", postalCode: "10310", country: "TH", subDistrict: "ห้วยขวาง", district: "ห้วยขวาง", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7563, longitude: 100.5679 } },
      contacts: { createMany: { data: [
        { name: "ประภาส อินทรโชติ",   position: "ผู้จัดการฝ่ายจัดซื้อ",        tel: "081-234-5678", email: "prapat@ntech.co.th",    lineId: "prapat_i" },
        { name: "วารุณี เพชรดี",       position: "ผู้จัดการฝ่าย Admin",         tel: "089-876-5432", email: "warunee@ntech.co.th",   lineId: "warunee_p" }
      ]}}
    },
    {
      id: ids.custSiamTech, tenantId: ids.tenant, ownerId: ids.rep,
      customerCode: "CUST-000002", name: "บริษัท สยามพร็อพเพอร์ตี้ กรุ๊ป จำกัด", taxId: "0105562234561",
      customerType: CustomerType.COMPANY,
      customFields: { customerTier: "Platinum" },
      addresses: { create: { addressLine1: "87 ถนนสีลม ชั้น 14", city: "กรุงเทพมหานคร", postalCode: "10500", country: "TH", subDistrict: "สีลม", district: "บางรัก", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7274, longitude: 100.5175 } },
      contacts: { createMany: { data: [
        { name: "กิตติพงษ์ วงศ์สกุล",  position: "ผู้อำนวยการฝ่ายโครงการ",    tel: "085-000-1111", email: "kittipong@siamproperty.th",  lineId: "kittipong_w", whatsapp: "660850001111" },
        { name: "ดาราวรรณ รักษ์ดี",    position: "เจ้าหน้าที่จัดซื้อ",         tel: "081-999-2222", email: "darawan@siamproperty.th",    lineId: "darawan_r" }
      ]}}
    },
    {
      id: ids.custBKKFood, tenantId: ids.tenant, ownerId: ids.rep2,
      customerCode: "CUST-000003", name: "บริษัท กรุงเทพประกันภัย (พ.ร.บ.) จำกัด มหาชน", taxId: "0107543345672",
      customerType: CustomerType.COMPANY,
      customFields: { customerTier: "Gold" },
      addresses: { create: { addressLine1: "25 ถนนสาทรใต้ ชั้น 8", city: "กรุงเทพมหานคร", postalCode: "10120", country: "TH", subDistrict: "ทุ่งมหาเมฆ", district: "สาทร", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7200, longitude: 100.5250 } },
      contacts: { createMany: { data: [
        { name: "ปรีดา จันทร์แก้ว",    position: "ผู้จัดการอาคารและสถานที่",    tel: "086-555-7890", email: "preeda@bkkins.co.th",    lineId: "preeda_c" },
        { name: "สุดารัตน์ โพธิ์ทอง",  position: "เจ้าหน้าที่จัดซื้อ",         tel: "084-333-6543", email: "sudarat@bkkins.co.th" }
      ]}}
    },
    {
      id: ids.custThaiSteel, tenantId: ids.tenant, ownerId: ids.rep2,
      customerCode: "CUST-000004", name: "บริษัท ไทยออโตโมทีฟ แมนูแฟคเจอริ่ง จำกัด", taxId: "0215554456783",
      customerType: CustomerType.COMPANY,
      customFields: { customerTier: "Silver" },
      addresses: { create: { addressLine1: "88 นิคมอุตสาหกรรมอีสเทิร์นซีบอร์ด", city: "ระยอง", postalCode: "21130", country: "TH", subDistrict: "มาบตาพุด", district: "เมืองระยอง", province: "ระยอง", isDefaultBilling: true, isDefaultShipping: true, latitude: 12.7018, longitude: 101.1401 } },
      contacts: { createMany: { data: [
        { name: "วิรัตน์ แสงทอง",       position: "ผู้จัดการฝ่าย Facility",      tel: "038-601-234", email: "wirat@thaiautomotive.co.th",   lineId: "wirat_s" },
        { name: "นภาพร ศิลาทอง",        position: "เจ้าหน้าที่จัดซื้อ",         tel: "083-777-4567", email: "napaporn@thaiautomotive.co.th" }
      ]}}
    },
    {
      id: ids.custPremier, tenantId: ids.tenant, ownerId: ids.rep3,
      customerCode: "CUST-000005", name: "โรงแรม แกรนด์ ทาวเวอร์ กรุงเทพ", taxId: "0105565567894",
      customerType: CustomerType.COMPANY,
      customFields: { customerTier: "Gold" },
      addresses: { create: { addressLine1: "1011 ถนนวิภาวดีรังสิต", city: "กรุงเทพมหานคร", postalCode: "10900", country: "TH", subDistrict: "จตุจักร", district: "จตุจักร", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: false } },
      contacts: { createMany: { data: [
        { name: "ธีระพงษ์ เจริญสุข",    position: "ผู้อำนวยการฝ่ายจัดซื้อ",    tel: "092-100-5678", email: "teerapong@grandtower.th",   lineId: "teerapong_j", whatsapp: "66921005678" },
        { name: "ศิริลักษณ์ ดวงดี",     position: "เจ้าหน้าที่ประสานงาน",      tel: "091-200-3456", email: "sirirak@grandtower.th" }
      ]}}
    },
    {
      id: ids.custEastAsia, tenantId: ids.tenant, ownerId: ids.rep3,
      customerCode: "CUST-000006", name: "บริษัท ฟิวเจอร์เวิร์ค สเปซ จำกัด", taxId: "0105566678905",
      customerType: CustomerType.COMPANY,
      customFields: { customerTier: "Silver" },
      addresses: { create: { addressLine1: "28 ถนนเจริญนคร ชั้น 6", city: "กรุงเทพมหานคร", postalCode: "10600", country: "TH", subDistrict: "คลองสาน", district: "คลองสาน", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7200, longitude: 100.5100 } },
      contacts: { createMany: { data: [
        { name: "จิรายุ มั่นคง",         position: "กรรมการผู้จัดการ",           tel: "081-888-9900", email: "jirayu@futurework.co.th",   lineId: "jirayu_m", whatsapp: "66818889900" }
      ]}}
    },
    {
      id: ids.custGolden, tenantId: ids.tenant, ownerId: ids.rep,
      customerCode: "CUST-000007", name: "บริษัท เดลต้า ก่อสร้างและพัฒนา จำกัด", taxId: "0105557789016",
      customerType: CustomerType.COMPANY,
      customFields: { customerTier: "Bronze" },
      addresses: { create: { addressLine1: "52 ถนนเพชรบุรีตัดใหม่", city: "กรุงเทพมหานคร", postalCode: "10400", country: "TH", subDistrict: "มักกะสัน", district: "ราชเทวี", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7520, longitude: 100.5580 } },
      contacts: { createMany: { data: [
        { name: "บุญรอด กาญจนา",         position: "ผู้จัดการโครงการ",           tel: "056-201-234", email: "boonrod@delta-construction.co.th",  lineId: "boonrod_k" },
        { name: "มณีรัตน์ สุขสวัสดิ์",   position: "นักบัญชี",                   tel: "083-456-7890", email: "maneerat@delta-construction.co.th" }
      ]}}
    },
    {
      id: ids.custRajaPlas, tenantId: ids.tenant, ownerId: ids.rep2,
      customerCode: "CUST-000008", name: "บริษัท เมดิคอล พลัส (ประเทศไทย) จำกัด", taxId: "0105568890127",
      customerType: CustomerType.COMPANY,
      customFields: { customerTier: "Silver" },
      addresses: { create: { addressLine1: "14/7 ถนนบรมราชชนนี", city: "กรุงเทพมหานคร", postalCode: "10160", country: "TH", subDistrict: "บางพลัด", district: "บางพลัด", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7800, longitude: 100.4700 } },
      contacts: { createMany: { data: [
        { name: "ประเสริฐ วงศ์วิจิตร",   position: "ผู้จัดการอาคาร",             tel: "089-654-3210", email: "prasert@medicalplus.co.th",   lineId: "prasert_w" },
        { name: "อรัญญา บุษบา",          position: "ผู้จัดการฝ่ายจัดซื้อ",       tel: "081-123-6789", email: "aranya@medicalplus.co.th" }
      ]}}
    },
    {
      id: ids.custCentral, tenantId: ids.tenant, ownerId: ids.rep3,
      customerCode: "CUST-000009", name: "บริษัท ซีพี เทรดดิ้ง อินเตอร์เนชั่นแนล จำกัด", taxId: "0107539901238",
      customerType: CustomerType.COMPANY,
      customFields: { customerTier: "Platinum" },
      addresses: { create: { addressLine1: "999 ถนนพระราม 1 ชั้น 30", city: "กรุงเทพมหานคร", postalCode: "10330", country: "TH", subDistrict: "ปทุมวัน", district: "ปทุมวัน", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: false, latitude: 13.7466, longitude: 100.5393 } },
      contacts: { createMany: { data: [
        { name: "วิไลพร พรหมสิทธิ์",     position: "ผู้อำนวยการฝ่ายบริหารสำนักงาน", tel: "082-222-3333", email: "wilaiporn@cptrading.co.th",   lineId: "wilaiporn_p", whatsapp: "66822223333" },
        { name: "เอกลักษณ์ ดวงฤทธิ์",    position: "ผู้จัดการฝ่ายจัดซื้อ",          tel: "081-444-5555", email: "eklak@cptrading.co.th",       lineId: "eklak_d"   }
      ]}}
    },
    {
      id: ids.custNorth, tenantId: ids.tenant, ownerId: ids.rep,
      customerCode: "CUST-000010", name: "บริษัท นอร์ทสตาร์ โลจิสติกส์ จำกัด", taxId: "0505510012349",
      customerType: CustomerType.COMPANY,
      customFields: { customerTier: "Bronze" },
      addresses: { create: { addressLine1: "78 ถนนนิมมานเหมินทร์", city: "เชียงใหม่", postalCode: "50200", country: "TH", subDistrict: "สุเทพ", district: "เมืองเชียงใหม่", province: "เชียงใหม่", isDefaultBilling: true, isDefaultShipping: true, latitude: 18.8004, longitude: 98.9600 } },
      contacts: { createMany: { data: [
        { name: "รัชนีกร ธาวรัตน์",      position: "เจ้าของกิจการ",              tel: "053-211-234", email: "ratchaneekorn@northstar-logistics.co.th", lineId: "ratchaneekorn_t" }
      ]}}
    },
    {
      id: ids.custSunrise, tenantId: ids.tenant, ownerId: ids.rep2,
      customerCode: "CUST-000011", name: "บริษัท กรีนเอิร์ธ เอนเนอร์ยี่ จำกัด", taxId: "0105571123450",
      customerType: CustomerType.COMPANY,
      customFields: { customerTier: "Gold" },
      addresses: { create: { addressLine1: "500 ถนนสุขุมวิท ชั้น 22", city: "กรุงเทพมหานคร", postalCode: "10110", country: "TH", subDistrict: "คลองเตย", district: "คลองเตย", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7200, longitude: 100.5700 } },
      contacts: { createMany: { data: [
        { name: "ณัฐพล จันทรา",          position: "หัวหน้าฝ่ายจัดซื้อ",         tel: "092-888-1234", email: "nattapol@greenearth.co.th",  lineId: "nattapol_c",  whatsapp: "66928881234" },
        { name: "ปาริชาติ สุทธิพงษ์",    position: "ผู้ช่วยผู้จัดการอาคาร",     tel: "098-765-4321", email: "parichat@greenearth.co.th" }
      ]}}
    },
    {
      id: ids.custMega, tenantId: ids.tenant, ownerId: ids.rep3,
      customerCode: "CUST-000012", name: "บริษัท โอเชี่ยน มีเดีย กรุ๊ป จำกัด", taxId: "0105572234561",
      customerType: CustomerType.COMPANY,
      customFields: { customerTier: "Bronze" },
      addresses: { create: { addressLine1: "12 ถนนลาดพร้าว", city: "กรุงเทพมหานคร", postalCode: "10230", country: "TH", subDistrict: "ลาดพร้าว", district: "ลาดพร้าว", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true } },
      contacts: { createMany: { data: [
        { name: "สิรินทร์ ภาสกร",         position: "กรรมการผู้จัดการ",           tel: "081-765-4321", email: "sirin@oceanmedia.co.th",  lineId: "sirin_p" }
      ]}}
    },
    {
      id: ids.custViva, tenantId: ids.tenant, ownerId: ids.rep,
      customerCode: "CUST-000013", name: "บริษัท ริเวอร์ไซด์ เรสซิเดนซ์ ดีเวลลอปเมนต์ จำกัด", taxId: "0105563345672",
      customerType: CustomerType.COMPANY,
      customFields: { customerTier: "Silver" },
      addresses: { create: { addressLine1: "301 ถนนรัชดาภิเษก", city: "กรุงเทพมหานคร", postalCode: "10320", country: "TH", subDistrict: "ดินแดง", district: "ดินแดง", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7700, longitude: 100.5600 } },
      contacts: { createMany: { data: [
        { name: "อาภาภรณ์ สุรินทราช",    position: "ผู้อำนวยการฝ่ายโครงการ",    tel: "089-123-4567", email: "apaporn@riverside-dev.co.th",  lineId: "apaporn_s" },
        { name: "กานต์ธิดา บุษรา",       position: "ผู้จัดการฝ่าย Admin",        tel: "086-234-5678", email: "kanthida@riverside-dev.co.th", whatsapp: "66862345678" }
      ]}}
    },
    {
      id: ids.custAmarin, tenantId: ids.tenant, ownerId: ids.rep2,
      customerCode: "CUST-000014", name: "บริษัท เอเชีย ฟาร์มาซูติคอล จำกัด", taxId: "0105574456783",
      customerType: CustomerType.COMPANY,
      customFields: { customerTier: "Silver" },
      addresses: { create: { addressLine1: "65/16 ถนนพระราม 6", city: "กรุงเทพมหานคร", postalCode: "10400", country: "TH", subDistrict: "พญาไท", district: "พญาไท", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true } },
      contacts: { createMany: { data: [
        { name: "วิชัยชนะ อินทร์เจริญ",  position: "ผู้จัดการฝ่าย Facility",      tel: "080-111-2233", email: "wichaichana@asiapharma.co.th", lineId: "wichaichana_i" }
      ]}}
    },
    {
      id: ids.custOmega, tenantId: ids.tenant, ownerId: ids.rep3,
      customerCode: "CUST-000015", name: "บริษัท อินฟินิตี้ เทค โซลูชั่นส์ จำกัด", taxId: "0105575567894",
      customerType: CustomerType.COMPANY,
      customFields: { customerTier: "Platinum" },
      addresses: { create: { addressLine1: "888 อาคารเอ็มไพร์ ถนนสาทรเหนือ ชั้น 25", city: "กรุงเทพมหานคร", postalCode: "10120", country: "TH", subDistrict: "ยานนาวา", district: "สาทร", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7200, longitude: 100.5300 } },
      contacts: { createMany: { data: [
        { name: "ชัยภัทร รุ่งเรือง",      position: "Chief Operating Officer",     tel: "038-457-890", email: "chaiyapat@infinitytech.co.th", lineId: "chaiyapat_r",  whatsapp: "66384578901" },
        { name: "ยุพา พิมลรัตน์",         position: "ผู้จัดการฝ่ายบริหารสำนักงาน", tel: "092-567-8901", email: "yupa@infinitytech.co.th" }
      ]}}
    }
  ];

  for (const data of customers) {
    await prisma.customer.create({ data });
  }
}
