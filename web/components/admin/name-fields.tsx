import { NAME_MAX_LENGTH } from "@/lib/limits";
import { FormField } from "@/components/forms/form-field";

interface NameFieldsProps {
  values?: { firstName?: string; middleName?: string | null; lastName?: string };
  errors: Partial<Record<string, string>>;
  /**
   * The new-user form: example names as placeholders, and the first name focused on arrival. An existing user's
   * profile has neither (an example under a cleared field would read like their data).
   */
  newUser?: boolean;
}

export function NameFields({ values, errors, newUser = false }: NameFieldsProps) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-3">
      <FormField
        label="First name"
        name="firstName"
        placeholder={newUser ? "Ada" : undefined}
        required
        maxLength={NAME_MAX_LENGTH}
        autoComplete="off"
        autoFocus={newUser}
        defaultValue={values?.firstName}
        error={errors.firstName}
      />
      <FormField
        label="Middle name"
        name="middleName"
        placeholder={newUser ? "Augusta" : undefined}
        optional
        maxLength={NAME_MAX_LENGTH}
        autoComplete="off"
        defaultValue={values?.middleName ?? undefined}
        error={errors.middleName}
      />
      <FormField
        label="Last name"
        name="lastName"
        placeholder={newUser ? "Lovelace" : undefined}
        required
        maxLength={NAME_MAX_LENGTH}
        autoComplete="off"
        defaultValue={values?.lastName}
        error={errors.lastName}
      />
    </div>
  );
}
