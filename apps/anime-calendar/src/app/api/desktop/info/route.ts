// Public identification only; no credentials, module configuration or user data.
export const GET = () => Response.json({ service: "home_theater", desktopProtocol: 2, name: "Пивосинема" }, { headers: { "Cache-Control": "no-store" } });
