import { LoginForm } from "../login/LoginForm";
export const metadata = {
  title: "Регистрация · home_theater",
  robots: { index: false, follow: false },
};
export default function Page() {
  return <LoginForm mode="register" />;
}
