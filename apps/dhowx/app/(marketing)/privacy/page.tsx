import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Dhow processes and stores your data.",
};

/**
 * Every claim below is traceable to code, not aspiration — see the report
 * from the wave that wrote this page for the file-by-file citations. Two
 * gaps are marked TODO rather than guessed at:
 *
 * - TODO(provider-terms): which model providers the hosted gateway uses by
 *   default, and whether we have zero-retention terms with them, is an open
 *   question (docs/plans/dhow-saas.md, "Open questions"). Do not fill this in
 *   without a signed agreement to point to — an incomplete section is safer
 *   than a false zero-retention claim.
 * - TODO(legal-jurisdiction): region-specific rights language (GDPR, CCPA,
 *   etc.) needs counsel review before publishing a specific claim.
 */
export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">
        Privacy Policy
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Last updated August 4, 2026
      </p>

      <div className="mt-10 space-y-10">
        <section className="space-y-3">
          <p className="text-muted-foreground">
            Dhow is two things: a desktop application that runs on your
            machine, and a hosted workspace at dhow.io that runs project-scoped
            agents for your team. What we store, and where, depends on which
            one you are using.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Data processed on your device
          </h2>
          <p className="text-muted-foreground">
            The desktop app is local-first: your mail and documents are read,
            indexed, and processed on your own machine, not uploaded to run
            the product. Application data and configuration live in a
            <code className="mx-1 rounded bg-muted px-1 py-0.5 text-sm">
              ~/.dhow/config
            </code>
            directory on disk.
          </p>
          <p className="text-muted-foreground">
            Where your operating system provides a keychain (Keychain on
            macOS, DPAPI on Windows, libsecret on Linux), credentials such as
            mail app passwords are encrypted before being written to disk. On
            a machine with no working keychain, credentials are stored in
            plain text rather than locking you out of the app — the same
            behavior every earlier version of the app had.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Account data, if you use the hosted workspace
          </h2>
          <p className="text-muted-foreground">
            Sign-in is handled by Supabase Auth. We store the email address
            associated with your account and the subject identifier Supabase
            Auth issues for it. That identifier, not your email, is the key
            we use internally to look up your account.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Product data, if you use the hosted workspace
          </h2>
          <p className="text-muted-foreground">
            Projects, conversations, workflows, and the documents you connect
            as data sources are stored in a MongoDB database we operate.
          </p>
          <p className="text-muted-foreground">
            When you connect documents so agents can search over them, we
            generate vector embeddings of that content and store them in a
            Qdrant vector database, so we can find relevant passages without
            re-scanning every document on each request.
          </p>
          <p className="text-muted-foreground">
            Background work — running a workflow, syncing a data source,
            firing a trigger — is queued and cached through Redis. That data
            is transient and used to run the job, not to build a profile of
            you.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            AI model providers
          </h2>
          <p className="text-muted-foreground">
            When an agent responds to you, the content of your prompt — and
            any document or email content you have brought into that
            conversation — is sent to an AI model provider to generate the
            response. That is how every part of the product that talks back
            to you works, on desktop and in the hosted workspace alike.
          </p>
          <p className="rounded-md border border-dashed border-muted-foreground/40 p-4 text-sm text-muted-foreground">
            TODO(provider-terms): we have not finalized, and are not claiming
            here, which providers the hosted gateway routes to by default or
            whether we have negotiated zero-retention terms with them. This
            section will name the providers and their retention terms once
            that is decided and contracted — not before.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Retention and deletion
          </h2>
          <p className="text-muted-foreground">
            We keep hosted workspace data for as long as your account is
            active. You can ask us to delete your account and the data
            associated with it; see Contact below.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Your rights
          </h2>
          <p className="text-muted-foreground">
            You can ask us to access, correct, export, or delete the personal
            data we hold about you by contacting us.
          </p>
          <p className="rounded-md border border-dashed border-muted-foreground/40 p-4 text-sm text-muted-foreground">
            TODO(legal-jurisdiction): rights specific to your region (for
            example GDPR in the EU/UK or CCPA in California) are not yet
            enumerated here and need counsel review before we make
            jurisdiction-specific claims.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">Changes</h2>
          <p className="text-muted-foreground">
            We may update this policy as the product changes. We will update
            the date at the top of this page when we do.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Contact
          </h2>
          <p className="text-muted-foreground">
            Questions about this policy or a request about your data:{" "}
            <a
              href="mailto:privacy@dhow.io"
              className="underline underline-offset-4"
            >
              privacy@dhow.io
            </a>
            .
          </p>
          <p className="rounded-md border border-dashed border-muted-foreground/40 p-4 text-sm text-muted-foreground">
            TODO(contact-inbox): confirm this inbox is provisioned and
            monitored before this page is submitted for Search Console or
            publisher verification.
          </p>
        </section>
      </div>
    </div>
  );
}
