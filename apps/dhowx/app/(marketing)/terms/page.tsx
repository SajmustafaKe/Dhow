import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that govern use of Dhow.",
};

/**
 * TODO(legal-governing-law): jurisdiction and venue are placeholders below,
 * pending counsel. Do not fill in a specific state/country without review —
 * this is exactly the kind of clause that needs a lawyer, not an inference.
 */
export default function TermsOfServicePage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">
        Terms of Service
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Last updated August 4, 2026
      </p>

      <div className="mt-10 space-y-10">
        <section className="space-y-3">
          <p className="text-muted-foreground">
            These terms govern your use of Dhow&apos;s desktop application and
            hosted workspace (together, the &quot;Service&quot;). By using the
            Service you agree to them.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Accounts
          </h2>
          <p className="text-muted-foreground">
            The hosted workspace requires signing in. You are responsible for
            activity that happens under your account, and for keeping your
            sign-in credentials secure.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Acceptable use
          </h2>
          <p className="text-muted-foreground">
            Do not use the Service to break the law, to build agents intended
            to harass, defraud, or deceive people, to attempt to access other
            users&apos; data or projects, or to circumvent usage limits or
            security controls.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            AI-generated output
          </h2>
          <p className="text-muted-foreground">
            Agents you build or use through the Service generate output using
            AI models. That output can be wrong, incomplete, or unsuitable
            for your purpose. You are responsible for reviewing it before you
            rely on it, especially for anything sent on your behalf or acted
            on automatically.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Fees
          </h2>
          <p className="text-muted-foreground">
            Some features may require a paid plan. Where they do, pricing and
            billing terms will be presented to you before you are charged.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            No warranty
          </h2>
          <p className="text-muted-foreground">
            The Service is provided &quot;as is&quot; and &quot;as
            available,&quot; without warranties of any kind, express or
            implied, including any warranty of merchantability, fitness for a
            particular purpose, or non-infringement.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Limitation of liability
          </h2>
          <p className="text-muted-foreground">
            To the maximum extent permitted by law, Dhow will not be liable
            for any indirect, incidental, special, consequential, or punitive
            damages, or for any loss of data, profits, or revenue, arising
            from your use of the Service.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Termination
          </h2>
          <p className="text-muted-foreground">
            You may stop using the Service at any time. We may suspend or
            terminate your access if you violate these terms or if we
            reasonably believe your use poses a risk to the Service or to
            other users.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Governing law
          </h2>
          <p className="rounded-md border border-dashed border-muted-foreground/40 p-4 text-sm text-muted-foreground">
            TODO(legal-governing-law): the governing law and venue for
            disputes have not been set and need counsel review before this
            section is filled in.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">Changes</h2>
          <p className="text-muted-foreground">
            We may update these terms as the product changes. We will update
            the date at the top of this page when we do.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Contact
          </h2>
          <p className="text-muted-foreground">
            Questions about these terms:{" "}
            <a
              href="mailto:legal@dhow.io"
              className="underline underline-offset-4"
            >
              legal@dhow.io
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
