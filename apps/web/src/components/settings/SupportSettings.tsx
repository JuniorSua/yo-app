/**
 * Settings → Support Yo. Yo is free and open source; giving back is optional and unlocks nothing. Both buttons open
 * the browser (lib/support.ts has the links).
 */
import { ArrowUpRight } from "lucide-react";
import { openExternal } from "../../lib/desktop";
import { CHIP_IN_URL, SOURCE_URL, SPONSOR_URL } from "../../lib/support";
import { Button } from "../ui/button";
import { H, Row } from "./parts";

export function SupportSettings() {
  return (
    <div data-testid="support-settings">
      <H>Support Yo</H>
      <div className="rounded-2xl border border-border bg-card px-5 py-5 shadow-card">
        <p className="max-w-[60ch] font-medium text-pretty">Yo is free and open source. It always will be.</p>
        <p className="mt-1.5 max-w-[60ch] text-muted text-sm text-pretty">
          If Yo gives you back a little time, you can give a little back. It keeps new things shipping.
          Totally optional: everything stays free either way.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" data-testid="support-chip-in" onClick={() => openExternal(CHIP_IN_URL)}>
            Chip in <ArrowUpRight className="size-4" />
          </Button>
          <Button data-testid="support-sponsor" onClick={() => openExternal(SPONSOR_URL)}>
            Sponsor monthly <ArrowUpRight className="size-4" />
          </Button>
        </div>
      </div>
      <div className="mt-4 rounded-2xl border border-border bg-card px-4 shadow-card">
        <Row title="View the code on GitHub" desc="Read it, fix it, or fork it. Apache-2.0.">
          <Button
            size="sm"
            variant="ghost"
            data-testid="support-source"
            onClick={() => openExternal(SOURCE_URL)}
          >
            Open <ArrowUpRight className="size-3.5" />
          </Button>
        </Row>
      </div>
      <p className="mt-3 px-1 text-muted text-xs">
        Support goes to the people building Yo. It isn't a charity, so it's not tax-deductible.
      </p>
    </div>
  );
}
