"use client";

import { X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  formatDuration,
  formatDurationLong,
  getEligibility,
} from "@/lib/catalogue/eligibility";
import type { CatalogueTitle } from "@/lib/catalogue/types";
import { StatusBadges } from "./status-badge";
import { GateMarks, TitleArtwork } from "./title-artwork";

type TitleRecordContextValue = { open: (id: string) => void };

const TitleRecordContext = createContext<TitleRecordContextValue | null>(null);

export function useTitleRecord() {
  const ctx = useContext(TitleRecordContext);
  if (!ctx) throw new Error("useTitleRecord must be used inside TitleRecordProvider");
  return ctx;
}

const rightsLabel: Record<CatalogueTitle["rightsStatus"], string> = {
  cleared: "Cleared for placement work",
  "pending-review": "In review",
  "not-cleared": "Not cleared",
};

const actorLabel: Record<CatalogueTitle["actorRestriction"], string> = {
  none: "No known restrictions",
  restricted: "Restricted",
  unknown: "Not yet confirmed",
};

const processingLabel: Record<CatalogueTitle["processingStatus"], string> = {
  "review-ready": "Review ready",
  processing: "Processing",
  "not-processed": "Not processed",
};

/** Holds which title record is open, and renders the single shared dialog. */
export function TitleRecordProvider({
  titles,
  children,
}: {
  titles: readonly CatalogueTitle[];
  children: ReactNode;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const selected = titles.find((t) => t.id === openId) ?? null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (selected && dialog && !dialog.open) dialog.showModal();
  }, [selected]);

  const open = useCallback((id: string) => setOpenId(id), []);
  const value = useMemo(() => ({ open }), [open]);
  const close = () => dialogRef.current?.close();

  return (
    <TitleRecordContext.Provider value={value}>
      {children}
      <dialog
        ref={dialogRef}
        aria-labelledby="title-record-heading"
        onClose={() => setOpenId(null)}
        onClick={(e) => {
          // Clicks on the backdrop land on the dialog element itself.
          if (e.target === e.currentTarget) close();
        }}
        className="title-record m-auto w-[min(44rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border border-line-strong bg-surface p-0 text-ink shadow-[0_40px_120px_-20px_rgb(0_0_0/0.8)]"
      >
        {selected && <TitleRecordBody title={selected} onClose={close} />}
      </dialog>
    </TitleRecordContext.Provider>
  );
}

function TitleRecordBody({
  title,
  onClose,
}: {
  title: CatalogueTitle;
  onClose: () => void;
}) {
  const eligibility = getEligibility(title);

  return (
    <article>
      <div className="relative aspect-[21/9] overflow-hidden">
        <TitleArtwork artwork={title.artwork} title={title.title} decorative className="absolute inset-0" />
        <GateMarks always />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close title record"
          className="absolute right-3 top-3 grid size-10 place-items-center rounded-full bg-canvas/70 text-ink backdrop-blur transition-colors hover:bg-canvas"
        >
          <X aria-hidden="true" className="size-5" />
        </button>
      </div>

      <div className="space-y-6 p-6 sm:p-8">
        <header className="space-y-3">
          <p className="text-sm text-muted">Title record</p>
          <h2 id="title-record-heading" className="type-condensed text-4xl font-bold leading-none tracking-tight">
            {title.title}
          </h2>
          <p className="max-w-prose text-base leading-relaxed text-ink-soft">{title.description}</p>
          <StatusBadges title={title} />
        </header>

        <EligibilityNote eligible={eligibility.eligible} reasons={eligibility.reasons} />

        <dl className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-line pt-6 text-sm sm:grid-cols-2">
          <Field label="Catalogue ID" value={title.id} />
          <Field label="Genre" value={title.genre} />
          <Field label="Tone" value={title.tone} />
          <Field label="Audience rating" value={title.rating} />
          <Field label="Rights" value={rightsLabel[title.rightsStatus]} />
          <Field label="Actor restrictions" value={actorLabel[title.actorRestriction]} />
          <Field
            label="Content sensitivity"
            value={title.contentSensitivity.level === "sensitive" ? "Sensitive" : "Standard"}
          />
          <Field label="Processing"value={processingLabel[title.processingStatus]} />
          <Field
            label="Runtime"
            value={<time dateTime={`PT${title.durationSeconds}S`} title={formatDurationLong(title.durationSeconds)}>{formatDuration(title.durationSeconds)}</time>}
          />
          <Field label="Generation pipeline" value={title.pipelineEnabled ? "Enabled" : "Not enabled"} />
          <Field label="Video" value={title.videoUrl ?? "Not uploaded yet"} />
          <Field
            label="Artwork"
            value={title.artwork.kind === "placeholder" ? "Placeholder artwork" : title.artwork.src}
          />
        </dl>
      </div>
    </article>
  );
}

export function EligibilityNote({
  eligible,
  reasons,
}: {
  eligible: boolean;
  reasons: string[];
}) {
  if (eligible) {
    return (
      <p className="rounded-xl border border-accent/30 bg-accent/[0.07] px-4 py-3 text-sm text-ink-soft">
        <strong className="font-semibold text-accent">Eligible for placement work.</strong>{" "}
        Rights are cleared, no actor restrictions are recorded, and the content is not flagged as
        sensitive.
      </p>
    );
  }
  return (
    <div className="rounded-xl border border-line-strong bg-white/[0.03] px-4 py-3 text-sm text-ink-soft">
      <p className="font-semibold text-ink">Not eligible yet</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5">
        {reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5 break-words font-medium text-ink">{value}</dd>
    </div>
  );
}

/** Button that opens a title's record. Pass className for layout. */
export function OpenTitleRecordButton({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  const { open } = useTitleRecord();
  return (
    <button type="button" onClick={() => open(id)} className={className}>
      {children}
    </button>
  );
}
