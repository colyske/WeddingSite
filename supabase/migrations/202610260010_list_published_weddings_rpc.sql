-- Add RPC for browsing published weddings with pagination (for landing page)

CREATE OR REPLACE FUNCTION list_published_weddings_paginated(p_offset INT DEFAULT 0, p_limit INT DEFAULT 12)
RETURNS TABLE (
  id UUID,
  couple_names TEXT,
  couple_slug TEXT,
  wedding_date DATE,
  location TEXT,
  currency TEXT,
  featured_until TIMESTAMP WITH TIME ZONE,
  has_fundraising BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    w.id,
    w.couple_names,
    w.couple_slug,
    w.wedding_date,
    w.location,
    w.currency,
    w.featured_until,
    (w.registry_milestones IS NOT NULL AND jsonb_array_length(w.registry_milestones) > 0)
  FROM weddings w
  WHERE w.published_at IS NOT NULL
    AND w.published_at <= NOW()
  ORDER BY
    CASE WHEN w.featured_until > NOW() THEN 0 ELSE 1 END,
    w.featured_until DESC,
    w.published_at DESC
  OFFSET p_offset
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION list_published_weddings_paginated IS 'List published weddings paginated for landing page. Featured weddings appear first.';
