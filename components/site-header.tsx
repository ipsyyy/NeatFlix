import { FlaskConical } from "lucide-react";
import Link from "next/link";

const sections = [
  { href: "/#featured", label: "Featured" },
  { href: "/#eligibility", label: "Eligibility" },
  { href: "/#titles", label: "All titles" },
  { href: "/demo", label: "Demo" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/75 backdrop-blur-xl">
      <div className="shell flex h-16 items-center gap-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 rounded-md text-ink">
          <Wordmark />
        </Link>

        <nav aria-label="Catalogue sections" className="hidden md:block">
          <ul className="flex items-center gap-1">
            {sections.map((s) => (
              <li key={s.href}>
                <Link
                  href={s.href}
                  className="rounded-full px-3.5 py-2 text-sm font-medium text-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
                >
                  {s.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <p className="ml-auto inline-flex items-center gap-2 rounded-full border border-line-strong px-3 py-1.5 text-xs font-medium text-ink-soft">
          <FlaskConical aria-hidden="true" className="size-3.5 text-accent" />
          <span>
            Demo environment<span className="hidden sm:inline">, fictional catalogue</span>
          </span>
        </p>
      </div>
    </header>
  );
}

function Wordmark() {
  return (
    <>
      {/* Mark: a frame gate with one placement point inside. */}
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6" fill="none">
        <path
          d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="14.5" cy="14" r="2.5" className="fill-accent" />
      </svg>
      <span className="type-wide text-[1.0625rem] font-bold tracking-tight">NeatFlix</span>
    </>
  );
}
