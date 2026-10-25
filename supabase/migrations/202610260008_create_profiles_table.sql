-- Create profiles table for role-based access control
-- Every user gets a profile when they register or are invited

CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  platform_role TEXT NOT NULL DEFAULT 'Client' CHECK (platform_role IN ('Owner', 'SuperAdmin', 'Admin', 'Client')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE profiles IS 'User profiles with role-based access control. Roles: Owner (invisible to others), SuperAdmin (sees all), Admin (assigned weddings), Client (default for new users).';
COMMENT ON COLUMN profiles.platform_role IS 'User role: Owner, SuperAdmin, Admin, or Client (new users default to Client).';

-- RLS: Users can only read their own profile; only Service Role can write
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Owner can read any profile" ON profiles
  FOR SELECT USING (
    auth.uid() IN (
      SELECT id FROM profiles WHERE platform_role = 'Owner'
    )
  );

-- Only Service Role (backend) can insert/update/delete via policy
-- Direct client writes are blocked (no INSERT/UPDATE/DELETE policies)
CREATE POLICY "Service role manages profiles" ON profiles
  USING (false)
  WITH CHECK (false);

-- Set up trigger to auto-create profile on user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, platform_role) VALUES (new.id, 'Client')
  ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- Owner is always role 'Owner' (not 'admin' or 'Admin')
-- Bootstrap: Update profiles for known Owner email (if exists)
-- This will be run after the Owner user is created in Supabase
DO $$
BEGIN
  UPDATE profiles SET platform_role = 'Owner' WHERE id IN (
    SELECT id FROM auth.users WHERE email = 'colyske@gmail.com'
  );
END $$;
