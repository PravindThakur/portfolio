export async function onRequestGet(context) {
    return new Response(
        JSON.stringify({
            success: true,
            message: "Job Search API is working!",
            timestamp: new Date().toISOString()
        }),
        {
            headers: {
                "Content-Type": "application/json"
            }
        }
    );
}
