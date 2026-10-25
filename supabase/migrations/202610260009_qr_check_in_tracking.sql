-- Add guest check-in tracking and e-card/QR verification support

-- Add checked_in_at column to guests table
ALTER TABLE guests ADD COLUMN checked_in_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN guests.checked_in_at IS 'When guest checked in (scanned QR) at the venue; null if not yet checked in.';

-- RPC to get guest pass data (e-card display)
-- Returns guest RSVP info needed for QR code and e-card display
CREATE OR REPLACE FUNCTION get_guest_pass_data(p_wedding_id UUID, p_guest_id UUID)
RETURNS TABLE (
  guest_id UUID,
  name TEXT,
  attending TEXT,
  dietary_needs TEXT,
  num_plus_ones INT,
  created_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    g.id,
    g.name,
    g.rsvp_status,
    g.dietary_preference,
    g.plus_ones,
    g.created_at
  FROM guests g
  WHERE g.wedding_id = p_wedding_id
    AND g.id = p_guest_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- RPC to mark guest as checked in (door verification)
-- Only callable by organizer; updates checked_in_at timestamp
CREATE OR REPLACE FUNCTION mark_guest_checked_in(p_wedding_id UUID, p_guest_id UUID)
RETURNS TABLE (
  guest_id UUID,
  name TEXT,
  attending TEXT,
  checked_in_at TIMESTAMP WITH TIME ZONE
) AS $$
DECLARE
  v_wedding_owner UUID;
  v_current_user UUID;
BEGIN
  v_current_user := auth.uid();
  IF v_current_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Verify caller is the wedding owner
  SELECT client_owner_id INTO v_wedding_owner FROM weddings WHERE id = p_wedding_id;
  IF v_wedding_owner IS NULL THEN
    RAISE EXCEPTION 'Wedding not found';
  END IF;
  IF v_wedding_owner != v_current_user THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  -- Update guest check-in timestamp
  UPDATE guests
  SET checked_in_at = NOW()
  WHERE id = p_guest_id AND wedding_id = p_wedding_id;

  -- Return updated guest info
  RETURN QUERY
  SELECT
    g.id,
    g.name,
    g.rsvp_status,
    g.checked_in_at
  FROM guests g
  WHERE g.id = p_guest_id AND g.wedding_id = p_wedding_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create index for fast check-in lookups
CREATE INDEX idx_guests_checked_in_at ON guests(wedding_id, checked_in_at)
WHERE checked_in_at IS NOT NULL;
