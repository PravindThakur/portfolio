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
     * Convert requested time to seconds
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
     * Build LinkedIn URL
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

    const linkedinUrl =
        "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?" +
        linkedinParams.toString();

    /*
     * Fetch LinkedIn with timeout
     */

    async function fetchLinkedIn() {

        const controller = new AbortController();

        const timeout = setTimeout(() => {
            controller.abort();
        }, 8000);

        try {

            const response = await fetch(
                linkedinUrl,
                {
                    method: "GET",

                    headers: {
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36",

                        "Accept":
                            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

                        "Accept-Language":
                            "en-US,en;q=0.9",

                        "Referer":
                            "https://www.linkedin.com/jobs/"
                    },

                    signal: controller.signal
                }
            );

            clearTimeout(timeout);

            return response;

        } catch (error) {

            clearTimeout(timeout);

            throw error;
        }
    }

    /*
     * Try LinkedIn twice
     */

    let response;
    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {

        try {

            response = await fetchLinkedIn();

            if (response.ok) {
                break;
            }

            lastError =
                `LinkedIn returned HTTP ${response.status}`;

        } catch (error) {

            lastError = error.message || "LinkedIn request failed";
        }

        /*
         * Small delay before retry
         */

        if (attempt === 1) {
            await new Promise(resolve =>
                setTimeout(resolve, 500)
            );
        }
    }

    /*
     * LinkedIn request failed
     */

    if (!response || !response.ok) {

        return new Response(
            JSON.stringify({
                success: false,
                error: "LinkedIn temporarily unavailable",
                details: lastError,
                retryable: true
            }),
            {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store"
                }
            }
        );
    }

    /*
     * Read LinkedIn HTML
     */

    let html;

    try {

        html = await response.text();

    } catch (error) {

        return new Response(
            JSON.stringify({
                success: false,
                error: "Unable to read LinkedIn response",
                details: error.message,
                retryable: true
            }),
            {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store"
                }
            }
        );
    }

    /*
     * Extract LinkedIn job cards
     */

    const jobCardRegex =
        /<li[^>]*>([\s\S]*?base-card[\s\S]*?)<\/li>/gi;

    const cards = [];

    let match;

    while ((match = jobCardRegex.exec(html)) !== null) {
        cards.push(match[1]);
    }

    /*
     * Convert cards into jobs
     */

    const jobs = cards.map(card => {

        const titleMatch =
            card.match(
                /<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i
            );

        const companyMatch =
            card.match(
                /<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i
            );

        const locationMatch =
            card.match(
                /<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i
            );

        const urlMatch =
            card.match(
                /<a[^>]*class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/i
            );

        const timeMatch =
            card.match(
                /<time[^>]*datetime="([^"]+)"[^>]*>([\s\S]*?)<\/time>/i
            );

        const idMatch =
            card.match(
                /data-entity-urn="urn:li:jobPosting:(\d+)"/i
            );

        return {
            title: cleanText(titleMatch?.[1]),
            company: cleanText(companyMatch?.[1]),
            location: cleanText(locationMatch?.[1]),
            posted: cleanText(timeMatch?.[2]),
            postedAt: timeMatch?.[1] || "",
            jobId: idMatch?.[1] || "",
            url: cleanUrl(urlMatch?.[1])
        };

    });

    /*
     * Remove invalid jobs
     */

    const validJobs = jobs.filter(job =>
        job.title &&
        job.company &&
        job.url
    );

    /*
     * Return successful response
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

            count: validJobs.length,

            jobs: validJobs,

            linkedin: {
                status: response.status,
                responseLength: html.length
            }

        }),
        {
            status: 200,

            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store"
            }
        }
    );
}


/*
 * Clean text extracted from HTML
 */

function cleanText(value) {

    if (!value) {
        return "";
    }

    return value
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}


/*
 * Clean LinkedIn URL
 */

function cleanUrl(value) {

    if (!value) {
        return "";
    }

    return value
        .replace(/&amp;/g, "&")
        .trim();
}
