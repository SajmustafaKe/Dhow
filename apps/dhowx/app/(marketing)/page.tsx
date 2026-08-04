import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function MarketingHomePage() {
  return (
    <>
      <section className="mx-auto w-full max-w-5xl px-6 py-24 text-center">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          An AI coworker for your inbox, your documents, and your team.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
          Dhow indexes your work into a living knowledge graph and gets things
          done where that work already lives — email, notes, meetings, code —
          and extends the same agents to a hosted workspace your team can
          build and run together.
        </p>
        <div className="mt-8 flex items-center justify-center gap-4">
          <Button asChild size="lg">
            <Link href="/auth/login">Sign in</Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <a href="https://github.com/SajmustafaKe/Dhow/releases">
              Download desktop
            </a>
          </Button>
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-24">
        <div className="grid gap-6 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Local-first on your desktop</CardTitle>
              <CardDescription>
                Mail, documents, and notes are processed on your machine, not
                uploaded to run Dhow. Credentials are stored locally and
                encrypted at rest wherever your OS provides a keychain.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Available for Mac, Windows, and Linux.
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>A hosted workspace for teams</CardTitle>
              <CardDescription>
                Project-scoped agents your team builds together: workflows, a
                copilot to help build them, connected data sources, and
                triggers that keep agents running on a schedule or on events.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Sign in to create a project and invite your team.
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="border-t">
        <div className="mx-auto w-full max-w-5xl px-6 py-16 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">
            Who Dhow is for
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
            People who want an AI agent working on their real inbox and
            documents without handing that data over to run it, and teams who
            want to build project-scoped agents together instead of prompting
            one at a time.
          </p>
        </div>
      </section>
    </>
  );
}
