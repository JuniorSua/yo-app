import { CloudOff, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyError } from "../lib/connection";
import { EmptyNote } from "./PageHeader";
import { Button } from "./ui/button";
import { Spinner } from "./ui/controls";

/**
 * Run a page's loader on mount and keep its failure, so the page can say what went wrong and offer a retry
 * instead of staying blank. `retry` runs it again.
 */
export function useLoad(loader: () => Promise<unknown>) {
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);
  const latest = useRef(loader);
  latest.current = loader;
  const retry = useCallback(() => {
    const id = ++attempt.current;
    setError(null);
    latest.current().catch((e) => {
      if (attempt.current === id) setError(friendlyError(e));
    });
  }, []);
  useEffect(() => {
    retry();
    return () => {
      attempt.current++;
    };
  }, [retry]);
  return { error, retry };
}

/**
 * What a list page shows before it has its list: a spinner while loading, or why it failed with a retry button.
 * Nothing once the list is there (a failed refresh keeps the list that's already on screen).
 */
export function LoadState({
  ready,
  error,
  retry,
  what,
}: {
  ready: boolean;
  error: string | null;
  retry: () => void;
  /** "your activity", "memories", ... */
  what: string;
}) {
  if (ready) return null;
  if (error)
    return (
      <div data-testid="load-failed" role="alert">
        <EmptyNote
          icon={<CloudOff />}
          title={`Couldn't load ${what}`}
          body={error}
          action={
            <Button onClick={retry} data-testid="load-retry">
              <RotateCw className="size-3.5" />
              Try again
            </Button>
          }
        />
      </div>
    );
  return (
    <div className="grid place-items-center py-16 text-muted" role="status" aria-label="Loading">
      <Spinner className="size-5" />
    </div>
  );
}
