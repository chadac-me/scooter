/**
 * The Services panel's "Add service" dialog: a short form whose answers become a chat
 * message asking Scooter to declare the service, since services are declared in-sandbox.
 */

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface AddServiceForm {
  name: string;
  purpose: string;
  command: string;
  port: string;
  start: boolean;
}

const EMPTY: AddServiceForm = { name: "", purpose: "", command: "", port: "", start: true };

/** The service's path segment, as the `webServices.<name>` option takes it. */
const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;

/** Why the form can't be sent yet, or null when it can. */
export function addServiceError(form: AddServiceForm, existing: readonly string[]): string | null {
  const name = form.name.trim();
  if (name && !NAME_RE.test(name)) return "Use lowercase letters, digits and dashes, starting with a letter.";
  if (existing.includes(name)) return `A service named “${name}” already exists.`;
  const port = form.port.trim();
  if (port && !(/^\d+$/.test(port) && +port >= 1024 && +port <= 65535)) return "Pick a port from 1024 to 65535.";
  return null;
}

/** The chat message that asks Scooter to build the service. */
export function addServicePrompt(form: AddServiceForm): string {
  const name = form.name.trim();
  const lines = [
    "Please add a web service to this sandbox.",
    "",
    `- Name: \`${name}\``,
    `- What it serves: ${form.purpose.trim()}`,
  ];
  if (form.command.trim()) lines.push(`- Start command: \`${form.command.trim()}\``);
  if (form.port.trim()) lines.push(`- Port: ${form.port.trim()}`);
  lines.push(
    "",
    `Declare it as \`webServices.${name}\` and apply it with \`scooter-rebuild switch\`.` +
      (form.start ? " Then start it and send me the link." : " Leave it stopped; I'll start it from the Services panel."),
  );
  return lines.join("\n");
}

const field = "rounded-md border border-input bg-background px-2 py-1.5 text-sm";
const label = "text-xs font-medium text-muted-foreground";

export function AddServiceDialog({
  open,
  onOpenChange,
  existing,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names already declared, which the new one must not reuse. */
  existing: readonly string[];
  /** Sends the built request to the conversation. */
  onSubmit: (prompt: string) => void;
}) {
  const [form, setForm] = useState<AddServiceForm>(EMPTY);
  useEffect(() => {
    if (open) setForm(EMPTY);
  }, [open]);
  const set = <K extends keyof AddServiceForm>(k: K, v: AddServiceForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const error = addServiceError(form, existing);
  const ready = !error && form.name.trim() !== "" && form.purpose.trim() !== "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    onSubmit(addServicePrompt(form));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="add-service-dialog" className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add a web service</DialogTitle>
            <DialogDescription>Describe it, and Scooter sets it up in this sandbox.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1">
            <label htmlFor="add-service-name" className={label}>Name</label>
            <input
              id="add-service-name"
              data-testid="add-service-name"
              value={form.name}
              onChange={(e) => set("name", e.target.value.toLowerCase())}
              placeholder="dashboard"
              autoComplete="off"
              className={`${field} font-mono`}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="add-service-purpose" className={label}>What should it serve?</label>
            <textarea
              id="add-service-purpose"
              data-testid="add-service-purpose"
              value={form.purpose}
              onChange={(e) => set("purpose", e.target.value)}
              placeholder="A Streamlit dashboard for /workspace/app.py"
              rows={3}
              className={field}
            />
          </div>

          <div className="flex gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor="add-service-command" className={label}>
                Start command <span className="font-normal">(optional)</span>
              </label>
              <input
                id="add-service-command"
                data-testid="add-service-command"
                value={form.command}
                onChange={(e) => set("command", e.target.value)}
                placeholder="streamlit run app.py"
                autoComplete="off"
                className={`${field} font-mono`}
              />
            </div>
            <div className="flex w-24 flex-col gap-1">
              <label htmlFor="add-service-port" className={label}>
                Port <span className="font-normal">(optional)</span>
              </label>
              <input
                id="add-service-port"
                data-testid="add-service-port"
                value={form.port}
                onChange={(e) => set("port", e.target.value)}
                placeholder="8501"
                inputMode="numeric"
                className={`${field} font-mono`}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="add-service-start"
              checked={form.start}
              onChange={(e) => set("start", e.target.checked)}
            />
            Start it once it&apos;s ready
          </label>

          {error ? (
            <p data-testid="add-service-error" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" data-testid="add-service-submit" disabled={!ready}>
              Ask Scooter
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
