import { desktopContract } from "@/desktop-contract";
// Public identification only; no credentials, module configuration or user data.
export const GET = () => Response.json({ service: "home_theater", desktopProtocol: 2, name: "Пивосинема", desktop: desktopContract }, { headers: { "Cache-Control": "no-store" } });
