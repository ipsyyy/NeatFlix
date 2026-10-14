import { CatalogueGrid } from "@/components/catalogue/catalogue-grid";
import { EligibilitySummary } from "@/components/catalogue/eligibility-summary";
import { FeaturedTitle } from "@/components/catalogue/featured-title";
import { TitleRecordProvider } from "@/components/catalogue/title-record";
import { SiteHeader } from "@/components/site-header";
import { catalogue, FEATURED_TITLE_ID } from "@/data/catalogue";

export default function CataloguePage() {
  const featured = catalogue.find((t) => t.id === FEATURED_TITLE_ID) ?? catalogue[0];

  return (
    <>
      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-accent px-4 py-2 font-semibold text-canvas focus:not-sr-only focus:fixed focus:left-4 focus:top-3"
      >
        Skip to catalogue
      </a>
      <SiteHeader />
      <TitleRecordProvider titles={catalogue}>
        <main id="main" tabIndex={-1} className="flex-1 outline-none">
          <h1 className="sr-only">NativeFrame catalogue</h1>
          <FeaturedTitle title={featured} />
          <EligibilitySummary titles={catalogue} />
          <CatalogueGrid titles={catalogue} />
        </main>
      </TitleRecordProvider>
      <footer className="border-t border-line">
        <p className="shell py-8 text-sm text-muted">
          Fictional streaming company. Titles, metadata, and artwork are temporary placeholders.
        </p>
      </footer>
    </>
  );
}
