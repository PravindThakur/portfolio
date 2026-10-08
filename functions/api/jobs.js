/**
 * Cloudflare Pages Function
 *
 * Purpose:
 * - Read the LinkedIn job archive from Cloudflare KV
 * - Never contact LinkedIn
 * - Return the complete 30-day archive
 * - Deduplicate by LinkedIn Job ID
 * - Normalize LinkedIn URLs
 * - Sort strictly by postedAt descending
 *
 * LinkedIn collection is handled exclusively by:
 * pravind-job-collector Worker
 *
 * KV Namespace binding:
 * JOB_ARCHIVE
 *
 * KV Key:
 * linkedin_jobs_archive_v1
 */

const ARCHIVE_DAYS = 30;

const ARCHIVE_KEY = "linkedin_jobs_archive_v1";


export async function onRequestGet(context) {

    try {

        /*
         * -----------------------------------------------------
         * 1. Read archive from KV
         * -----------------------------------------------------
         */

        const archive =
            await context.env.JOB_ARCHIVE.get(
                ARCHIVE_KEY,
                "json"
            );


        /*
         * No archive yet
         */

        if (
            !archive
        ) {

            return jsonResponse({

                success: true,

                count: 0,

                newlyAdded: 0,

                retention: "30 days",

                refreshedAt: null,

                source: "Cloudflare KV archive",

                linkedin: "not_contacted",

                jobs: []

            });

        }


        /*
         * Support both:
         *
         * {
         *   jobs: [...]
         * }
         *
         * and
         *
         * [...]
         */

        let jobs =
            Array.isArray(archive)
                ? archive
                : Array.isArray(archive.jobs)
                    ? archive.jobs
                    : [];


        const archiveUpdatedAt =
            Array.isArray(archive)
                ? null
                : archive.updatedAt ||
                  archive.refreshedAt ||
                  null;


        /*
         * -----------------------------------------------------
         * 2. Calculate 30-day cutoff
         * -----------------------------------------------------
         */

        const now =
            Date.now();


        const cutoffTime =
            now -
            ARCHIVE_DAYS *
            24 *
            60 *
            60 *
            1000;


        /*
         * -----------------------------------------------------
         * 3. Normalize and remove invalid records
         * -----------------------------------------------------
         */

        const normalizedJobs = [];


        for (
            const originalJob of jobs
        ) {

            if (
                !originalJob ||
                !originalJob.jobId
            ) {

                continue;

            }


            const postedTime =
                new Date(
                    originalJob.postedAt || 0
                ).getTime();


            /*
             * Ignore records without
             * a valid postedAt.
             */

            if (
                !Number.isFinite(
                    postedTime
                )
            ) {

                continue;

            }


            /*
             * Remove jobs older
             * than 30 days.
             */

            if (
                postedTime <
                cutoffTime
            ) {

                continue;

            }


            const job = {

                ...originalJob,

                jobId:
                    String(
                        originalJob.jobId
                    ),

                title:
                    String(
                        originalJob.title || ""
                    ).trim(),

                company:
                    String(
                        originalJob.company || ""
                    ).trim(),

                location:
                    String(
                        originalJob.location || ""
                    ).trim(),

                postedText:
                    String(
                        originalJob.postedText ||
                        originalJob.posted ||
                        ""
                    ).trim(),

                postedAt:
                    new Date(
                        postedTime
                    ).toISOString(),

                url:
                    cleanLinkedInUrl(
                        originalJob.url
                    )

            };


            /*
             * Ignore incomplete records.
             */

            if (
                !job.title ||
                !job.company
            ) {

                continue;

            }


            normalizedJobs.push(
                job
            );

        }


        /*
         * -----------------------------------------------------
         * 4. Deduplicate by LinkedIn Job ID
         * -----------------------------------------------------
         */

        const uniqueJobs =
            new Map();


        for (
            const job of normalizedJobs
        ) {

            const existing =
                uniqueJobs.get(
                    job.jobId
                );


            /*
             * If duplicate exists,
             * keep the record with the
             * newest postedAt.
             */

            if (
                !existing
            ) {

                uniqueJobs.set(
                    job.jobId,
                    job
                );

            } else {

                const existingTime =
                    new Date(
                        existing.postedAt
                    ).getTime();


                const currentTime =
                    new Date(
                        job.postedAt
                    ).getTime();


                if (
                    currentTime >
                    existingTime
                ) {

                    uniqueJobs.set(
                        job.jobId,
                        job
                    );

                }

            }

        }


        jobs =
            Array.from(
                uniqueJobs.values()
            );


        /*
         * -----------------------------------------------------
         * 5. Sort newest first
         *
         * IMPORTANT:
         * Use LinkedIn postedAt.
         *
         * Do NOT use discoveredAt.
         * Do NOT use array order.
         * -----------------------------------------------------
         */

        jobs.sort(
            (
                a,
                b
            ) => {

                const dateA =
                    new Date(
                        a.postedAt
                    ).getTime();


                const dateB =
                    new Date(
                        b.postedAt
                    ).getTime();


                return dateB - dateA;

            }
        );


        /*
         * -----------------------------------------------------
         * 6. Return archive
         * -----------------------------------------------------
         */

        return jsonResponse({

            success: true,

            count:
                jobs.length,

            newlyAdded: 0,

            retention:
                "30 days",

            refreshedAt:
                archiveUpdatedAt,

            source:
                "Cloudflare KV archive",

            linkedin:
                "not_contacted",

            sorted:
                "postedAt descending",

            jobs

        });

    } catch (error) {

        console.error(
            "Jobs API error:",
            error
        );


        return jsonResponse({

            success: false,

            count: 0,

            jobs: [],

            error:
                "Unable to read job archive."

        }, 500);

    }

}


/*
 * ============================================================
 * Normalize LinkedIn URL
 * ============================================================
 *
 * Converts:
 *
 * [https://www.linkedin.com/jobs/view/123456/](https://...)
 *
 * into:
 *
 * https://www.linkedin.com/jobs/view/123456/
 *
 *
 * Also removes LinkedIn tracking/query parameters:
 *
 * ?position=...
 * &pageNum=...
 * &refId=...
 * &trackingId=...
 *
 * Result:
 *
 * https://www.linkedin.com/jobs/view/123456/
 *
 * ============================================================
 */

function cleanLinkedInUrl(
    value
) {

    if (
        !value
    ) {

        return "";

    }


    let url =
        String(
            value
        )
            .trim();


    /*
     * Remove Markdown link wrapper.
     *
     * Example:
     *
     * [https://linkedin.com/...](https://linkedin.com/...)
     */

    const markdownMatch =
        url.match(
            /^\[.*?\]\((https?:\/\/[^)]+)\)$/i
        );


    if (
        markdownMatch
    ) {

        url =
            markdownMatch[1];

    }


    /*
     * Decode HTML entities.
     */

    url =
        url
            .replace(
                /&amp;/g,
                "&"
            )
            .replace(
                /\\u002F/g,
                "/"
            );


    /*
     * Convert relative LinkedIn URL.
     */

    if (
        url.startsWith("/")
    ) {

        url =
            "https://www.linkedin.com" +
            url;

    }


    /*
     * Remove query string.
     *
     * LinkedIn tracking parameters
     * are unnecessary for the job page.
     */

    try {

        const parsed =
            new URL(
                url
            );


        if (
            parsed.hostname
                .toLowerCase()
                .includes("linkedin.com")
        ) {

            return (
                parsed.origin +
                parsed.pathname
            );

        }

    } catch (error) {

        /*
         * If URL parsing fails,
         * return the original cleaned value.
         */

    }


    return url;

}


/*
 * ============================================================
 * JSON Response helper
 * ============================================================
 */

function jsonResponse(
    data,
    status = 200
) {

    return new Response(

        JSON.stringify(
            data
        ),

        {

            status,

            headers: {

                "Content-Type":
                    "application/json; charset=UTF-8",

                /*
                 * Always obtain the latest
                 * archive from KV.
                 *
                 * Do not allow the browser
                 * or CDN to cache an old API response.
                 */

                "Cache-Control":
                    "no-store, no-cache, must-revalidate",

                "Pragma":
                    "no-cache",

                "Expires":
                    "0"

            }

        }

    );

}
