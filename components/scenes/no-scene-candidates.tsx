import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { CatalogueTitle } from "@/lib/catalogue/types";

export function NoSceneCandidates({ title }: { title: CatalogueTitle }) {
  return (
    <section aria-labelledby="no-scenes-heading" className="shell py-16">
      <div className="max-w-xl rounded-2xl border border-line bg-surface/60 p-8">
        <h2 id="no-scenes-heading" className="text-xl font-semibold text-ink">
          No scene candidates yet
        </h2>
        <p className="mt-2 leading-relaxed text-ink-soft">
          Scene analysis hasn&rsquo;t run for {title.title}. Candidates will appear here once it
          has, with evidence for each decision.
        </p>
        <Link
          href="/#titles"
          className="mt-6 inline-flex items-center gap-2 rounded-full border border-line-strong px-5 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-white/[0.06]"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to catalogue
        </Link>
      </div>
    </section>
  );
}
