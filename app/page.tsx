import { Suspense } from "react";
import { CatalogueGrid } from "@/components/catalogue/catalogue-grid";
import { EligibilitySummary } from "@/components/catalogue/eligibility-summary";
import { FeaturedTitle } from "@/components/catalogue/featured-title";
import { PlacementComparison, PlacementComparisonFallback } from "@/components/catalogue/placement-comparison";
import { TitleRecordProvider } from "@/components/catalogue/title-record";
import { catalogue, FEATURED_TITLE_ID } from "@/data/catalogue";
import { loadTitleMedia } from "./load-title-media";

export default function CataloguePage() {
  const featured = catalogue.find((t) => t.id === FEATURED_TITLE_ID) ?? catalogue[0];
  // Not awaited: the catalogue prerenders, and the video and case evidence streams at request time.
  const media = loadTitleMedia();

  return (
    <TitleRecordProvider titles={catalogue} media={media}>
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        <h1 className="sr-only">NeatFlix catalogue</h1>
        <FeaturedTitle title={featured} />
        <EligibilitySummary titles={catalogue} />
        <Suspense fallback={<PlacementComparisonFallback />}>
          <PlacementComparison titles={catalogue} media={media} />
        </Suspense>
        <CatalogueGrid titles={catalogue} />
      </main>
    </TitleRecordProvider>
  );
}
