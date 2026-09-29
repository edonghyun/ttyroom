package dev.ttyroom.architecture;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;

import dev.ttyroom.TtyRoomApplication;

import org.junit.jupiter.api.Test;

class ArchitectureTests {
    private static final String DOMAIN = "dev.ttyroom.domain..";
    private static final String APPLICATION = "dev.ttyroom.application..";

    // Import the entire production output, including future packages, but never test fixtures.
    // The location comes from the compiled entry point, so it also works outside the repo cwd.
    private static final JavaClasses PRODUCTION =
            new ClassFileImporter()
                    .importUrl(
                            TtyRoomApplication.class
                                    .getProtectionDomain()
                                    .getCodeSource()
                                    .getLocation());

    @Test
    void domainDependsOnlyOnDomainAndJavaStandardTypes() {
        classes()
                .that()
                .resideInAPackage(DOMAIN)
                .should()
                .onlyDependOnClassesThat()
                .resideInAnyPackage(DOMAIN, "java..")
                .because(
                        "domain state and policy must not know application, transport or"
                            + " frameworks")
                .check(PRODUCTION);
    }

    @Test
    void applicationDependsOnlyOnApplicationDomainAndJavaStandardTypes() {
        classes()
                .that()
                .resideInAPackage(APPLICATION)
                .should()
                .onlyDependOnClassesThat()
                .resideInAnyPackage(APPLICATION, DOMAIN, "java..")
                .because(
                        "application owns use cases and ports; adapters own Spring and wire"
                            + " encoding")
                .check(PRODUCTION);
    }

    @Test
    void adaptersCommunicateThroughApplicationInsteadOfEachOther() {
        slices().matching("dev.ttyroom.adapter.(*)..")
                .should()
                .notDependOnEachOther()
                .because("each adapter owns its protocol or infrastructure integration")
                .check(PRODUCTION);
    }

    @Test
    void productionClassesBelongToAnExplicitBoundary() {
        classes()
                .that()
                .doNotHaveFullyQualifiedName(TtyRoomApplication.class.getName())
                .should()
                .resideInAnyPackage(DOMAIN, APPLICATION, "dev.ttyroom.adapter.*..")
                .because("new packages must not silently bypass the dependency rules")
                .check(PRODUCTION);
    }

    @Test
    void theCompositionRootIsNotUsedByOtherProductionClasses() {
        noClasses()
                .should()
                .dependOnClassesThat()
                .haveFullyQualifiedName(TtyRoomApplication.class.getName())
                .because("startup assembles the application; it is not a service locator")
                .check(PRODUCTION);
    }
}
