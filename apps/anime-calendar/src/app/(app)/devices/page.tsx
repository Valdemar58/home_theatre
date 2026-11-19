import { Devices } from "@/components/Devices";
import { Suspense } from "react";
export const metadata = { title: "Мои устройства" };
export default function Page() {
  return (
    <Suspense>
      <Devices />
    </Suspense>
  );
}
