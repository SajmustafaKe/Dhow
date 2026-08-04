import AppLayout from './components/app-layout';

export default async function Layout({
    children
}: {
    params: { projectId: string }
    children: React.ReactNode
}) {
    return (
        <AppLayout>
            {children}
        </AppLayout>
    );
} 