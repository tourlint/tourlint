import { redirect } from "next/navigation";

// 설정 탭은 검수 기준 탭으로 바뀌었다 (설정 탭 개편안 · UI-S8). 옛 /settings 북마크는
// 그대로 살려 /standard 로 넘긴다.
export default function SettingsPage() {
  redirect("/standard");
}
