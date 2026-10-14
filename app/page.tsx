import { CatalogueGrid } from "@/components/catalogue/catalogue-grid";
import { EligibilitySummary } from "@/components/catalogue/eligibility-summary";
import { FeaturedTitle } from "@/components/catalogue/featured-title";
import { TitleRecordProvider } from "@/components/catalogue/title-record";
import { catalogue, FEATURED_TITLE_ID } from "@/data/catalogue";

export default function CataloguePage() {
  const featured = catalogue.find((t) => t.id === FEATURED_TITLE_ID) ?? catalogue[0];

  return (
    <TitleRecordProvider titles={catalogue}>
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        <h1 className="sr-only">NativeFrame catalogue</h1>
        <FeaturedTitle title={featured} />
        <EligibilitySummary titles={catalogue} />
        <CatalogueGrid titles={catalogue} />
      </main>
    </TitleRecordProvider>
  );
}
