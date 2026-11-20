import { MaintenanceNotice } from "@/components/MaintenanceNotice";
export default function MaintenancePage() {
  return <main className="mx-auto max-w-2xl px-4 py-16"><h1 className="mb-6 text-2xl font-semibold text-gray-100">Обслуживание сервера</h1><MaintenanceNotice standalone /></main>;
}
