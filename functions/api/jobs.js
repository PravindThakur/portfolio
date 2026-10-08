export async function onRequestGet(context) {

    const url = new URL(context.request.url);

    const keywords = url.searchParams.get("keywords") || "Business Analyst";
    const location = url.searchParams.get("location") || "India";

    const timeValue = Number(
        url.searchParams.get("timeValue") || 60
    );

    const timeUnit =
        url.searchParams.get("timeUnit") || "minutes";

    const sort =
        url.searchParams.get("sort") || "newest";

    const workplace =
        url.searchParams.get("workplace") || "";

    const skills =
        url.searchParams.get("skills") || "";

    /*
     * Convert the selected time period to minutes.
     */

    let minutes = timeValue;

    if (timeUnit === "hours") {
        minutes = timeValue * 60;
    }

    if (timeUnit === "days") {
        minutes = timeValue * 24 * 60;
    }

    /*
     * Return the parameters for now.
     * The actual job provider will be connected next.
     */

    return new Response(
        JSON.stringify({
            success: true,

            filters: {
                keywords,
                location,
                timeValue,
                timeUnit,
                minutes,
                workplace: workplace
                    ? workplace.split(",")
                    : [],
                skills: skills
                    ? skills.split(",")
                    : [],
                sort
            },

            jobs: []
        }),
        {
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store"
            }
        }
    );
}
