import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/app/lib/supabase";

export async function POST(request: NextRequest) {
    const supabase = await createClient();
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/", request.nextUrl.origin));
}
