import type { Metadata } from "next";
import { Suspense } from "react";
import { DemoStory } from "@/components/demo/demo-story";
import { DEMO_STEPS } from "@/components/demo/steps";

export const metadata: Metadata = {
  title: "End-to-end demo · NeatFlix",
  description: "Case NF-DEMO-0001 from campaign to human-approved placement, with the evidence behind every step.",
};

export default function DemoPage() {
  return (
    <main id="main" className="flex-1">
      <header className="border-b border-line">
        <div className="shell space-y-4 pb-8 pt-8">
          <p className="text-[0.9375rem] text-ink-soft">End-to-end demo · case NF-DEMO-0001</p>
          <h1 className="type-condensed text-[clamp(2.25rem,5.5vw,4rem)] font-extrabold leading-[0.95] text-ink">One placement, from campaign to human approval</h1>
          <p className="max-w-3xl text-ink-soft">
            Every step below shows NeatFlix&apos;s approved records and privately stored media for this case. Nothing is regenerated and no AI provider is
            called during the demo. Each step says whether its evidence was checked live just now or recorded earlier.
          </p>
          <nav aria-label="Demo steps">
            <ol className="flex flex-wrap gap-2 pt-2">
              {DEMO_STEPS.map((s, i) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className="inline-flex rounded-full border border-line-strong px-3 py-1.5 text-sm text-ink-soft transition-colors hover:border-accent hover:text-ink">
                    {i + 1}. {s.short}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </div>
      </header>
      <Suspense fallback={<p className="shell py-12 text-muted">Loading the verified case records…</p>}>
        <DemoStory />
      </Suspense>
    </main>
  );
}
