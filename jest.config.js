module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/*.spec.ts"],

  // Bỏ qua các ảnh chụp trước khi refactor và thư mục build.
  //
  // Vì sao cần: `_backup_truoc_khi_fix_*/` chứa BẢN SAO của toàn bộ src/, kể
  // cả các file .spec.ts. Jest chạy song song bản gốc và bản sao, hai tiến
  // trình cùng thực thi `GRANT ... TO app_rls` trên cùng hàng catalog của
  // PostgreSQL và ném "tuple concurrently updated" — một lỗi ngẫu nhiên trông
  // như bug RLS nhưng thật ra là hai bộ test giẫm chân nhau.
  //
  // Các thư mục backup vẫn được GIỮ để đối chiếu (xem README §6), chỉ là không
  // được coi là mã sống.
  testPathIgnorePatterns: [
    "/node_modules/",
    "/dist/",
    "_backup_truoc_khi_fix_",
    "_to_delete",
  ],
  verbose: true,
  forceExit: true,
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
};
