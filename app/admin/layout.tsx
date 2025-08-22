// app/admin/layout.tsx
import "../globals.css"; // importa i CSS globali anche per il subtree /admin
import type { ReactNode } from "react";

export const metadata = {
  title: "Sinflora — Admin",
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <section className="min-h-screen bg-gray-50">
      {children}
    </section>
  );
}
