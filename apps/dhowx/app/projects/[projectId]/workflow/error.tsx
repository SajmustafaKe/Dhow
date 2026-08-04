"use client";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

export default function Error(props: { error: Error }) {
    return (
        <Alert variant="destructive">
            <AlertTitle>Error loading workflow</AlertTitle>
            <AlertDescription>
                There was an error loading the workflow: {props.error.message}
            </AlertDescription>
        </Alert>
    );
}
