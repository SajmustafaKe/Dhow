import "./globals.css";
import { ThemeProvider } from "./providers/theme-provider";
import { Inter } from "next/font/google";
import { Providers } from "./providers";
import { Metadata } from "next";
import { HelpModalProvider } from "./providers/help-modal-provider";
import { UserProvider } from "./providers/user-provider";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: "Dhow labs",
    template: "%s | Dhow",
  }
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <html lang="en" className="h-dvh">
    <UserProvider>
      <ThemeProvider>
        <body className={`${inter.className} h-full text-base [scrollbar-width:thin] bg-background`}>
          <Providers className='h-full flex flex-col'>
            <HelpModalProvider>
              {children}
            </HelpModalProvider>
          </Providers>
        </body>
      </ThemeProvider>
    </UserProvider>
  </html>;
}
