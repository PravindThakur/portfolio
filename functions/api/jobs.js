export async function onRequestGet(context) {

    const requestUrl = new URL(context.request.url);

    const keywords =
        requestUrl.searchParams.get("keywords") ||
        "Business Analyst";

    const location =
        requestUrl.searchParams.get("location") ||
        "India";

    const timeValue =
        Number(requestUrl.searchParams.get("timeValue")) || 60;

    const timeUnit =
        requestUrl.searchParams.get("timeUnit") || "minutes";

    const sort =
        requestUrl.searchParams.get("sort") || "newest";

    const workplace =
        requestUrl.searchParams.get("workplace") || "";

    const skills =
        requestUrl.searchParams.get("skills") || "";


    /*
     * Convert Minutes / Hours / Days into seconds
     */

    let seconds = timeValue;

    if (timeUnit === "minutes") {
        seconds = timeValue * 60;
    }

    if (timeUnit === "hours") {
        seconds = timeValue * 60 * 60;
    }

    if (timeUnit === "days") {
        seconds = timeValue * 24 * 60 * 60;
    }


    /*
     * LinkedIn job search parameters
     */

    const linkedinParams = new URLSearchParams();

    linkedinParams.set("keywords", keywords);

    linkedinParams.set("location", location);

    linkedinParams.set("f_TPR", `r${seconds}`);

    linkedinParams.set(
        "sortBy",
        sort === "newest" ? "DD" : "R"
    );

    linkedinParams.set("start", "0");


    /*
     * LinkedIn guest job endpoint
     */

    const linkedinUrl =
        "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?" +
        linkedinParams.toString();


    try {

        const response = await fetch(linkedinUrl, {

            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36",

                "Accept":
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

                "Accept-Language":
                    "en-US,en;q=0.9",

                "Referer":
                    "https://www.linkedin.com/jobs/"
            }

        });


        /*
         * Check LinkedIn response
         */

        if (!response.ok) {

            return new Response(

                JSON.stringify({

                    success: false,

                    error:
                        `LinkedIn returned HTTP ${response.status}`,

                    linkedinUrl: linkedinUrl

                }),

                {
                    status: 502,

                    headers: {
                        "Content-Type":
                            "application/json"
                    }
                }

            );

        }


        const html = await response.text();


        /*
         * Return basic diagnostic information.
         *
         * We are intentionally NOT parsing jobs yet.
         */

        return new Response(

            JSON.stringify({

                success: true,

                source: "LinkedIn guest jobs endpoint",

                search: {

                    keywords,

                    location,

                    timeValue,

                    timeUnit,

                    seconds,

                    workplace:
                        workplace
                            ? workplace.split(",")
                            : [],

                    skills:
                        skills
                            ? skills.split(",")
                            : [],

                    sort

                },

                linkedin: {

                    status: response.status,

                    responseLength:
                        html.length,

                    containsJobCards:
                        html.includes("base-card"),

                    containsJobResults:
                        html.includes("job-search-card"),

                    url:
                        linkedinUrl

                }

            }),

            {

                headers: {

                    "Content-Type":
                        "application/json",

                    "Cache-Control":
                        "no-store"

                }

            }

        );

    } catch (error) {

        return new Response(

            JSON.stringify({

                success: false,

                error:
                    "Unable to connect to LinkedIn",

                details:
                    error.message

            }),

            {

                status: 502,

                headers: {

                    "Content-Type":
                        "application/json",

                    "Cache-Control":
                        "no-store"

                }

            }

        );

    }

}
