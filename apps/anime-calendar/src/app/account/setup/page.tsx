import { LoginForm } from "../../login/LoginForm";
export const metadata = {
  title: "Настройка аккаунта · home_theater",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default function Page() {
  return <LoginForm mode="setup" />;
}
